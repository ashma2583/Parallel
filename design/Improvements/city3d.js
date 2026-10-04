/* Stylised isometric city on <canvas>. window.CityRenderer.
   new CityRenderer(canvas, { geo, nodes, edges, colors, onSelect }) ; setNodes(nodes) ; setSelected(id) ; resize() ; destroy() */
(function () {
  'use strict';
  function rng(seed) { var s = 0; for (var i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function hex(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function mix(a, b, t) { return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' + Math.round(a[1] + (b[1] - a[1]) * t) + ',' + Math.round(a[2] + (b[2] - a[2]) * t) + ')'; }
  function shade(rgb, f) { return [rgb[0] * f, rgb[1] * f, rgb[2] * f]; }

  function CityRenderer(canvas, opts) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.geo = opts.geo; this.edges = opts.edges || []; this.onSelect = opts.onSelect || function () {};
    this.colors = opts.colors; this.padRight = opts.padRight || 0; this.selected = null; this.hover = null;
    this.cam = { bearing: -0.35, pitch: 1.0, zoom: 0.22, cx: 0, cy: 0 };
    this.anim = {}; this.target = {}; this.status = {};
    this.build(opts.nodes);
    this.bindEvents();
    this.resize();
    this.setNodes(opts.nodes, true);
    var self = this; this.loop = function () { self.frame(); self.raf = requestAnimationFrame(self.loop); }; this.raf = requestAnimationFrame(this.loop);
  }
  CityRenderer.prototype.build = function (nodes) {
    var ids = Object.keys(this.geo), self = this;
    var lat0 = 42.288, lng0 = -83.722, kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
    this.world = {}; ids.forEach(function (id) { self.world[id] = { x: (self.geo[id][0] - lng0) * kx, y: -(self.geo[id][1] - lat0) * ky }; });
    var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    this.boxes = []; this.nodeTop = {};
    ids.forEach(function (id) {
      var n = byId[id], w = self.world[id], r = rng(id), sup = n.type === 'substation';
      var count = sup ? 9 : Math.min(40, 10 + Math.round(n.demand / 7)), spread = sup ? 80 : 75 + Math.sqrt(n.occupancy) * 2.6, maxH = 0;
      for (var i = 0; i < count; i++) {
        var a = r() * Math.PI * 2, d = Math.pow(r(), 0.6) * spread, fx = 16 + r() * 20, fy = 16 + r() * 20;
        var h = sup ? (i === 0 ? 60 : 18 + r() * 24) : /hospital/.test(n.type) ? 40 + r() * 70 : /dorm/.test(n.type) ? 34 + r() * 60 : 20 + r() * 48;
        if (i === 0 && !sup) { d = 0; fx = 32; fy = 32; h += 26; }
        maxH = Math.max(maxH, h);
        self.boxes.push({ x: w.x + Math.cos(a) * d, y: w.y + Math.sin(a) * d, fx: fx, fy: fy, h: h, node: id });
      }
      self.nodeTop[id] = maxH;
    });
    // filler blocks on a jittered grid, away from clusters
    var r2 = rng('filler'), xs = ids.map(function (i) { return self.world[i].x; }), ys = ids.map(function (i) { return self.world[i].y; });
    var x0 = Math.min.apply(null, xs) - 1600, x1 = Math.max.apply(null, xs) + 1600, y0 = Math.min.apply(null, ys) - 1300, y1 = Math.max.apply(null, ys) + 1300;
    this.bounds = { x0: x0, x1: x1, y0: y0, y1: y1 };
    var core = ids.filter(function (i) { return i !== 'ncrc'; }), cxs = core.map(function (i) { return self.world[i].x; }), cys = core.map(function (i) { return self.world[i].y; });
    this.fit = { x0: Math.min.apply(null, cxs), x1: Math.max.apply(null, cxs), y0: Math.min.apply(null, cys), y1: Math.max.apply(null, cys) };
    for (var gx = x0; gx < x1; gx += 85) for (var gy = y0; gy < y1; gy += 85) {
      if (r2() > 0.6) continue;
      var px = gx + (r2() - 0.5) * 30, py = gy + (r2() - 0.5) * 30, near = false;
      for (var k = 0; k < ids.length && !near; k++) { var ww = self.world[ids[k]]; if ((ww.x - px) * (ww.x - px) + (ww.y - py) * (ww.y - py) < 190 * 190) near = true; }
      if (near) continue;
      this.boxes.push({ x: px, y: py, fx: 22 + r2() * 26, fy: 22 + r2() * 26, h: 8 + r2() * 26, node: null });
    }
    // roads: campus road edges + a loose grid
    this.roads = [];
    this.edges.forEach(function (e) { if (e.type !== 'road') return; var a = self.world[e.source], b = self.world[e.target]; self.roads.push([a.x, a.y, b.x, b.y, 2]); });
    var r3 = rng('roads');
    for (var rx = x0; rx < x1; rx += 260) { var j = (r3() - 0.5) * 120; self.roads.push([rx + j, y0, rx + j + (r3() - 0.5) * 400, y1, 1]); }
    for (var ry = y0; ry < y1; ry += 260) { var j2 = (r3() - 0.5) * 120; self.roads.push([x0, ry + j2, x1, ry + j2 + (r3() - 0.5) * 400, 1]); }
    this.cam.cx = (this.fit.x0 + this.fit.x1) / 2; this.cam.cy = (this.fit.y0 + this.fit.y1) / 2;
  };
  CityRenderer.prototype.setNodes = function (nodes, instant) {
    var self = this;
    nodes.forEach(function (n) {
      var t = n.status === 'Green' ? 1 : n.status === 'Amber' ? 0.5 : 0;
      self.status[n.id] = n; self.target[n.id] = t;
      if (instant || self.anim[n.id] == null) self.anim[n.id] = t;
    });
  };
  CityRenderer.prototype.setSelected = function (id) { this.selected = id; };
  CityRenderer.prototype.resize = function () {
    var dpr = Math.min(2, window.devicePixelRatio || 1), w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.dpr = dpr; this.w = w; this.h = h;
    if (!this.fitted) { this.fitted = true; var f = this.fit, pad = this.padRight || 0; this.cam.zoom = Math.min((w - pad - 60) / (f.x1 - f.x0), (h - 180) / ((f.y1 - f.y0) * Math.sin(this.cam.pitch))) * 1.05; this.cam.cx = (f.x0 + f.x1) / 2; this.cam.cy = (f.y0 + f.y1) / 2; this.panX = -pad / 2; this.panY = 30; }
  };
  CityRenderer.prototype.project = function (x, y, z) {
    var c = this.cam, cb = Math.cos(c.bearing), sb = Math.sin(c.bearing);
    var xr = (x - c.cx) * cb - (y - c.cy) * sb, yr = (x - c.cx) * sb + (y - c.cy) * cb;
    var pf = Math.sin(c.pitch), hf = Math.cos(c.pitch);
    return { x: this.w / 2 + (this.panX || 0) + xr * c.zoom, y: this.h / 2 + (this.panY || 0) + yr * c.zoom * pf - z * c.zoom * hf * 1.1, depth: yr };
  };
  CityRenderer.prototype.bindEvents = function () {
    var self = this, cv = this.canvas, drag = null;
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey, b: self.cam.bearing, p: self.cam.pitch, cx: self.cam.cx, cy: self.cam.cy }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', function (e) {
      var rect = cv.getBoundingClientRect(); self.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.pan) { var c = self.cam, cb = Math.cos(c.bearing), sb = Math.sin(c.bearing), pf = Math.sin(c.pitch); var wx = dx / c.zoom, wy = dy / c.zoom / pf; c.cx = drag.cx - (wx * cb + wy * sb); c.cy = drag.cy - (-wx * sb + wy * cb); }
      else { self.cam.bearing = drag.b + dx * 0.006; self.cam.pitch = Math.max(0.55, Math.min(1.35, drag.p - dy * 0.005)); }
    });
    var up = function (e) { if (drag && !drag.moved) self.click(e); drag = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', function () { drag = null; });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('wheel', function (e) { e.preventDefault(); self.cam.zoom = Math.max(0.04, Math.min(3, self.cam.zoom * Math.exp(-e.deltaY * 0.0012))); }, { passive: false });
  };
  CityRenderer.prototype.click = function (e) {
    var rect = this.canvas.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top, best = null, bd = 26 * 26;
    for (var id in this.pins) { var p = this.pins[id], d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my); if (d < bd) { bd = d; best = id; } }
    this.onSelect(best);
  };
  CityRenderer.prototype.frame = function () {
    var ctx = this.ctx, C = this.colors; if (!this.w) { this.resize(); if (!this.w) return; }
    if (this.canvas.clientWidth !== this.w || this.canvas.clientHeight !== this.h) this.resize();
    var self = this, ids = Object.keys(this.target);
    ids.forEach(function (id) { var a = self.anim[id], t = self.target[id]; self.anim[id] = Math.abs(t - a) < 0.01 ? t : a + (t - a) * 0.08; });
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.ground; ctx.fillRect(0, 0, this.w, this.h);
    // ground plane
    var g = this.bounds, p0 = this.project(g.x0, g.y0, 0), p1 = this.project(g.x1, g.y0, 0), p2 = this.project(g.x1, g.y1, 0), p3 = this.project(g.x0, g.y1, 0);
    ctx.fillStyle = C.plane; ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath(); ctx.fill();
    // roads
    ctx.lineCap = 'round';
    this.roads.forEach(function (r) { var a = self.project(r[0], r[1], 0), b = self.project(r[2], r[3], 0); ctx.strokeStyle = r[4] === 2 ? C.roadMajor : C.road; ctx.lineWidth = r[4] === 2 ? Math.max(1.2, 9 * self.cam.zoom) : Math.max(0.6, 5 * self.cam.zoom); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); });
    // glow under lit clusters
    var lit = hex(C.lit), litDeep = hex(C.litDeep), dark = hex(C.darkBld), red = hex(C.reduced), fill = hex(C.filler);
    ids.forEach(function (id) {
      var t = self.anim[id]; if (t < 0.05) return; var w = self.world[id], p = self.project(w.x, w.y, 0), r = (90 + Math.sqrt(self.status[id].occupancy) * 2.5) * self.cam.zoom;
      var gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r); gr.addColorStop(0, 'rgba(' + lit.join(',') + ',' + (0.28 * t) + ')'); gr.addColorStop(1, 'rgba(' + lit.join(',') + ',0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r * Math.sin(self.cam.pitch), 0, 0, Math.PI * 2); ctx.fill();
    });
    // buildings, back to front
    var cb = Math.cos(this.cam.bearing), sb = Math.sin(this.cam.bearing);
    var boxes = this.boxes.map(function (b) { return { b: b, d: (b.x - self.cam.cx) * sb + (b.y - self.cam.cy) * cb }; }).sort(function (a, b) { return a.d - b.d; });
    var zoom = this.cam.zoom;
    boxes.forEach(function (o) {
      var b = o.b, top, side1, side2;
      if (b.node) {
        var t = self.anim[b.node], st = self.status[b.node], base = st && st.status === 'Amber' && t < 0.9 ? red : lit;
        var topC = t < 0.5 ? mix(dark, base, t * 2) : mix(base, lit, 0); topC = mix(dark, base, Math.min(1, t * 1.2));
        top = topC; side1 = mix(shade(dark, 0.75), shade(base === lit ? litDeep : base, 0.85), Math.min(1, t * 1.2)); side2 = mix(shade(dark, 0.55), shade(base === lit ? litDeep : base, 0.6), Math.min(1, t * 1.2));
        if (self.selected === b.node) { top = C.text; }
      } else { top = mix(fill, fill, 0); side1 = mix(shade(fill, 0.75), fill, 0); side2 = mix(shade(fill, 0.55), fill, 0); }
      var hx = b.fx / 2, hy = b.fy / 2, cs = [[b.x - hx, b.y - hy], [b.x + hx, b.y - hy], [b.x + hx, b.y + hy], [b.x - hx, b.y + hy]];
      var P0 = cs.map(function (c) { return self.project(c[0], c[1], 0); }), P1 = cs.map(function (c) { return self.project(c[0], c[1], b.h); });
      if (P0[0].x < -60 && P0[2].x < -60 || P0[0].x > self.w + 60 && P0[2].x > self.w + 60 || P1[0].y > self.h + 60 || P0[2].y < -60) return;
      // side faces whose outward normal faces the viewer
      var normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (var i = 0; i < 4; i++) { var n = normals[i], ny = n[0] * sb + n[1] * cb; if (ny <= 0) continue; var j = (i + 1) % 4; ctx.fillStyle = (n[0] !== 0) ? side1 : side2; ctx.beginPath(); ctx.moveTo(P0[i].x, P0[i].y); ctx.lineTo(P0[j].x, P0[j].y); ctx.lineTo(P1[j].x, P1[j].y); ctx.lineTo(P1[i].x, P1[i].y); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = top; ctx.beginPath(); ctx.moveTo(P1[0].x, P1[0].y); for (var k = 1; k < 4; k++) ctx.lineTo(P1[k].x, P1[k].y); ctx.closePath(); ctx.fill();
    });
    // pins
    this.pins = {};
    var pinOrder = ids.slice().sort(function (a, b) { return self.project(self.world[a].x, self.world[a].y, 0).depth - self.project(self.world[b].x, self.world[b].y, 0).depth; });
    pinOrder.forEach(function (id) {
      var w = self.world[id], st = self.status[id], t = self.anim[id], p = self.project(w.x, w.y, self.nodeTop[id] + 24 / Math.max(0.3, zoom * 4));
      var s = id === self.selected ? 1.25 : 1, pinC = st.status === 'Green' ? C.pin : st.status === 'Amber' ? C.reduced : C.pinOff, boltC = st.status === 'Red' ? C.pinOffBolt : C.ground;
      self.pins[id] = { x: p.x, y: p.y - 14 * s };
      ctx.save(); ctx.translate(p.x, p.y); ctx.scale(s, s);
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(0, 2, 7, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pinC; ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(-12, -14, -12, -30, 0, -30); ctx.bezierCurveTo(12, -30, 12, -14, 0, 0); ctx.fill();
      ctx.fillStyle = boltC; ctx.beginPath(); ctx.moveTo(1.5, -27); ctx.lineTo(-4, -17.5); ctx.lineTo(-0.5, -17.5); ctx.lineTo(-2, -11); ctx.lineTo(4, -20.5); ctx.lineTo(0.5, -20.5); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (id === self.selected || id === self.hover || zoom > 0.34) { ctx.font = '500 11px IBM Plex Sans, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = C.ground; ctx.fillStyle = C.text; ctx.strokeText(st.short, p.x, p.y - 36 * s); ctx.fillText(st.short, p.x, p.y - 36 * s); }
    });
    if (this.mouse) { var h = null, bd = 20 * 20; for (var id2 in this.pins) { var pp = this.pins[id2], d = (pp.x - this.mouse.x) * (pp.x - this.mouse.x) + (pp.y - this.mouse.y) * (pp.y - this.mouse.y); if (d < bd) { bd = d; h = id2; } } this.hover = h; this.canvas.style.cursor = h ? 'pointer' : 'grab'; }
  };
  CityRenderer.prototype.destroy = function () { cancelAnimationFrame(this.raf); };
  window.CityRenderer = CityRenderer;
})();
