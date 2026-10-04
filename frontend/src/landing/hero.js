/* PARALLEL hero. Self-contained: graph data, constraint model, SVG drawing, tick controller.
   Reads page colour tokens: --powered --reduced --dark --line --accent --hair --panel --text --muted.
   The model below mirrors backend/graph.py and backend/agents/logic.py, so the numbers on the
   landing page are the numbers the engine produces for the same scenario. */

  // campus-graph.json, inlined. x/y are the layout positions from the app.
  var NODES = [
    ['cpp', 'Central Power Plant', 'Central Plant', 'substation', 'none', 'central', 620, 0, 0, 40, 520, 220],
    ['uh', 'University Hospital', 'Hospital', 'hospital', 'critical', 'medical', 0, 260, 640, 800, 860, 80],
    ['north_switch', 'North Campus Switching Station', 'North Switching', 'substation', 'none', 'north', 560, 0, 0, 12, 1180, 40],
    ['angell', 'Angell Hall', 'Angell', 'academic', 'high', 'central', 0, 90, 0, 400, 220, 80],
    ['shapiro', 'Shapiro Undergraduate Library', 'Shapiro', 'library', 'low', 'central', 0, 60, 0, 500, 220, 280],
    ['union', 'Michigan Union', 'Union', 'dining', 'medium', 'central', 0, 50, 0, 350, 40, 180],
    ['ross', 'Ross School of Business', 'Ross', 'academic', 'medium', 'central', 0, 80, 0, 400, 220, 460],
    ['markley', 'Mary Markley Hall', 'Markley', 'dorm', 'high', 'central', 0, 110, 0, 1200, 520, 40],
    ['south_quad', 'South Quad', 'South Quad', 'dorm', 'high', 'central', 0, 100, 0, 1100, 40, 400],
    ['mott', "C.S. Mott Children's Hospital", 'Mott', 'hospital', 'critical', 'medical', 0, 190, 0, 420, 860, 280],
    ['kahn', 'Kahn Health Care Pavilion', 'Kahn', 'hospital', 'high', 'medical', 0, 150, 150, 300, 1060, 180],
    ['beyster', 'Beyster Building', 'Beyster', 'academic', 'high', 'north', 0, 100, 0, 450, 1180, 220],
    ['duderstadt', 'Duderstadt Center', 'Duderstadt', 'library', 'low', 'north', 0, 40, 0, 300, 1400, 120],
    ['pierpont', 'Pierpont Commons', 'Pierpont', 'dining', 'medium', 'north', 0, 35, 0, 250, 1180, 400],
    ['bursley', 'Bursley Hall', 'Bursley', 'dorm', 'high', 'north', 0, 120, 0, 1300, 980, 400],
    ['gg_brown', 'G.G. Brown Laboratories', 'G.G. Brown', 'academic', 'medium', 'north', 0, 70, 0, 350, 1400, 300],
    ['ncrc', 'North Campus Research Complex', 'NCRC', 'research', 'medium', 'north', 0, 90, 50, 200, 1400, 480],
    ['city_hall', 'Larcom City Hall', 'City Hall', 'civic', 'medium', 'city_hall', 0, 25, 40, 80, 40, 620],
    ['blake', 'Blake Transit Center', 'Blake Transit', 'transit', 'low', 'blake', 0, 10, 20, 60, 240, 640],
    ['fire_1', 'Fire Station 1', 'Fire Stn 1', 'civic', 'high', 'fire_1', 0, 15, 25, 18, 440, 640]
  ].map(function (r) {
    return { id: r[0], name: r[1], short: r[2], type: r[3], priority: r[4], feeder: r[5], capacity: r[6], demand: r[7], local: r[8], occupancy: r[9], x: r[10], y: r[11] };
  });
  var EDGES = [
    ['cpp', 'angell'], ['cpp', 'shapiro'], ['cpp', 'union'], ['cpp', 'ross'], ['cpp', 'markley'], ['cpp', 'south_quad'], ['cpp', 'uh'],
    ['uh', 'mott'], ['uh', 'kahn'],
    ['north_switch', 'beyster'], ['north_switch', 'duderstadt'], ['north_switch', 'pierpont'], ['north_switch', 'bursley'], ['north_switch', 'gg_brown'], ['north_switch', 'ncrc']
  ].map(function (e) { return { s: e[0], t: e[1], type: 'power' }; }).concat([
    ['union', 'angell'], ['angell', 'shapiro'], ['shapiro', 'ross'], ['ross', 'south_quad'], ['union', 'south_quad'], ['angell', 'cpp'], ['cpp', 'markley'],
    ['markley', 'uh'], ['cpp', 'uh'], ['uh', 'mott'], ['uh', 'kahn'], ['mott', 'kahn'], ['union', 'blake'], ['blake', 'city_hall'], ['blake', 'fire_1'],
    ['north_switch', 'beyster'], ['beyster', 'duderstadt'], ['beyster', 'pierpont'], ['beyster', 'gg_brown'], ['pierpont', 'bursley'], ['gg_brown', 'ncrc'],
    ['north_switch', 'ncrc'], ['pierpont', 'blake']
  ].map(function (e) { return { s: e[0], t: e[1], type: 'road' }; }));

  var byId = {};
  NODES.forEach(function (n) { byId[n.id] = n; });
  var RANK = { low: 0, medium: 1, high: 2, critical: 3, none: -1 };
  var SCENARIO = { central: 0.35, north: 0.5 }; // heat wave, 95°F
  // Emergency feeder from the Central Power Plant into Michigan Medicine.
  var MEDICAL_TIE_KW = 140;
  var FEEDERS = NODES.reduce(function (acc, n) { if (acc.indexOf(n.feeder) < 0) acc.push(n.feeder); return acc; }, []);

  // Shed order per policy. Ties break the way the engine breaks them: bigger load first, then id.
  function byTier(a, b) { return RANK[a.priority] - RANK[b.priority] || b.demand - a.demand || (a.id < b.id ? -1 : 1); }
  function keepLast(test) { return function (a, b) { return test(a) - test(b) || byTier(a, b); }; }
  var POLICIES = [
    { id: 'tiered', name: 'Priority tiers', desc: 'Shed the lowest priority tier first. Critical care is never shed.', sort: byTier },
    { id: 'residential', name: 'Protect residential', desc: 'Keep dorms powered. Academic and commons buildings go dark first.', sort: keepLast(function (n) { return n.type === 'dorm'; }) },
    { id: 'academic', name: 'Protect classes', desc: 'Keep classrooms and libraries powered. Residence halls go dark first.', sort: keepLast(function (n) { return n.type === 'academic' || n.type === 'library'; }) },
    { id: 'people', name: 'Most people per kW', desc: 'Shed the buildings that serve the fewest people per kilowatt first.', sort: function (a, b) { return a.occupancy / a.demand - b.occupancy / b.demand || (a.id < b.id ? -1 : 1); } },
    { id: 'even', name: 'Ration evenly', desc: 'No load shedding. Every building on the feed gets the same share.', ration: true }
  ];
  function stateFor(f) { return f >= 0.9 ? 'ok' : f >= 0.5 ? 'reduced' : 'dark'; }

  // The constraint: a feed can serve no more than its supply. Nothing invents power.
  // f is the share of a building's demand that is delivered.
  function solve(policy, factors) {
    var st = {}, order = [];
    FEEDERS.forEach(function (feed) {
      var fac = factors[feed] == null ? 1 : factors[feed];
      var members = NODES.filter(function (n) { return n.feeder === feed; });
      var consumers = members.filter(function (n) { return n.type !== 'substation'; });
      var supply = members.reduce(function (a, n) { return a + (n.type === 'substation' ? n.capacity * fac : n.local); }, 0);
      if (feed === 'medical') supply += MEDICAL_TIE_KW;
      var remaining = Math.max(0, consumers.reduce(function (a, n) { return a + n.demand; }, 0) - supply);
      var shed = {};
      if (!policy.ration) {
        consumers.filter(function (n) { return n.priority !== 'critical'; }).sort(policy.sort).forEach(function (n) {
          if (remaining <= 1e-6) return;
          shed[n.id] = n.demand <= remaining + 1e-6 ? 1 : remaining / n.demand;
          remaining -= n.demand * shed[n.id];
        });
      }
      var wanted = consumers.reduce(function (a, n) { return a + n.demand * (1 - (shed[n.id] || 0)); }, 0);
      var ratio = wanted <= 0 ? 1 : Math.min(1, supply / wanted);
      members.forEach(function (n) {
        if (n.type === 'substation') { st[n.id] = { state: fac >= 0.9 ? 'ok' : 'reduced', f: fac }; return; }
        var f = (1 - (shed[n.id] || 0)) * ratio;
        st[n.id] = { state: stateFor(f), f: f };
      });
      consumers.slice().sort(policy.ration ? byTier : policy.sort).forEach(function (n) { if (st[n.id].state === 'dark') order.push(n.id); });
    });
    var essDem = 0, essServed = 0, dark = 0, moved = 0;
    NODES.forEach(function (n) {
      if (n.type === 'substation') return;
      if (RANK[n.priority] >= 2) { essDem += n.demand; essServed += n.demand * st[n.id].f; }
      if (st[n.id].state === 'dark') { dark++; moved += n.occupancy; }
    });
    return { states: st, order: order, essential: essServed / essDem, dark: dark, moved: moved };
  }

  // ---------- drawing ----------
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  var STYLE =
    '.ph-road{stroke:var(--hair);stroke-width:1.2;stroke-dasharray:2 6;opacity:.7}' +
    '.ph-pw{stroke:var(--line);stroke-width:1.6;opacity:.45;transition:opacity .5s,stroke .5s}' +
    '.ph-flow{stroke:var(--line);stroke-width:1.6;stroke-dasharray:3 10;stroke-linecap:round;opacity:.95;transition:opacity .5s}' +
    '.ph-anim .ph-flow{animation:ph-flow 1.1s linear infinite}' +
    '.ph-low .ph-flow{animation-duration:2.6s;opacity:.4}' +
    '.ph-off .ph-flow{opacity:0}.ph-off .ph-pw{stroke:var(--hair);opacity:1}' +
    '.ph-node .ph-shape{fill:var(--panel);stroke:var(--powered);stroke-width:2;transition:stroke .45s,fill .45s}' +
    '.ph-node .ph-core{fill:var(--powered);transition:fill .45s}' +
    '.ph-reduced .ph-shape{stroke:var(--reduced)}.ph-reduced .ph-core{fill:var(--reduced)}' +
    '.ph-dark .ph-shape{stroke:var(--dark)}.ph-dark .ph-core{fill:var(--dark);opacity:.35}' +
    '.ph-halo{fill:none;stroke:var(--dark);stroke-width:2;opacity:0;transform-box:fill-box;transform-origin:center}' +
    '.ph-anim .ph-dark .ph-halo{animation:ph-halo 1.6s ease-out infinite}' +
    '.ph-hit{fill:transparent;cursor:pointer}' +
    '.ph-click .ph-node:hover .ph-shape{stroke-width:3}' +
    '.ph-label{font:500 13px "IBM Plex Sans",system-ui,sans-serif;fill:var(--text);opacity:.9;pointer-events:none}' +
    '.ph-sub{font:400 11px "IBM Plex Mono",ui-monospace,monospace;fill:var(--muted);pointer-events:none}' +
    '.ph-num{font:500 42px "IBM Plex Mono",ui-monospace,monospace;fill:var(--text)}' +
    '.ph-pct{font-size:22px;fill:var(--muted)}' +
    '.ph-pol{font:500 15px "IBM Plex Sans",system-ui,sans-serif;fill:var(--text)}' +
    '.ph-meta{font:400 12px "IBM Plex Mono",ui-monospace,monospace;fill:var(--muted)}' +
    '.ph-branch{fill:none;stroke:var(--accent);stroke-width:1.5;opacity:.9}' +
    '.ph-frame{fill:none;stroke:var(--hair);stroke-width:1;transition:stroke .4s}' +
    '.ph-frame.ph-pick{stroke:var(--accent);stroke-width:1.5}' +
    '.ph-live,.ph-track,.ph-branches{transition:transform 1.1s cubic-bezier(.6,0,.2,1),opacity .7s}' +
    '.ph-big .ph-label{font-size:25px}.ph-big .ph-sub{font-size:19px}' +
    '.ph-live .ph-label,.ph-live .ph-sub{transition:opacity .4s}' +
    '.ph-small .ph-label,.ph-small .ph-sub,.ph-bare .ph-label,.ph-bare .ph-sub{opacity:0}' +
    '.ph-wide .ph-num{font-size:46px}.ph-wide .ph-pct{font-size:24px}.ph-wide .ph-pol{font-size:21px}.ph-wide .ph-meta{font-size:18px}' +
    '.ph-instant *{transition:none!important}' +
    '@keyframes ph-flow{to{stroke-dashoffset:-26}}' +
    '@keyframes ph-halo{0%{opacity:.6;transform:scale(1)}100%{opacity:0;transform:scale(2)}}';

  function ensureStyle(svg) {
    if (svg.querySelector('style[data-ph]')) return;
    var s = el('style', { 'data-ph': '' });
    s.textContent = STYLE;
    svg.insertBefore(s, svg.firstChild);
  }

  // Draws the campus one-line diagram into a <g>. Graph space is 1440x680.
  function drawGraph(parent, opts) {
    opts = opts || {};
    var g = el('g', { class: 'ph-graph' }, parent);
    var r = opts.r || 14, nodes = {}, edges = [];
    EDGES.forEach(function (e) {
      var a = byId[e.s], b = byId[e.t];
      if (e.type === 'road') {
        if (opts.roads !== false) el('line', { class: 'ph-road', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, g);
        return;
      }
      var eg = el('g', { class: 'ph-edge' }, g);
      el('line', { class: 'ph-pw', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, eg);
      el('line', { class: 'ph-flow', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, eg);
      edges.push({ el: eg, s: e.s, t: e.t });
    });
    NODES.forEach(function (n) {
      var ng = el('g', { class: 'ph-node', 'data-id': n.id }, g);
      el('circle', { class: 'ph-halo', cx: n.x, cy: n.y, r: r }, ng);
      if (n.type === 'substation') {
        el('rect', { class: 'ph-shape', x: n.x - r - 2, y: n.y - r - 2, width: 2 * r + 4, height: 2 * r + 4, rx: 5 }, ng);
        el('rect', { class: 'ph-core', x: n.x - 4, y: n.y - 7, width: 8, height: 14, rx: 1.5 }, ng);
      } else {
        el('circle', { class: 'ph-shape', cx: n.x, cy: n.y, r: r }, ng);
        el('circle', { class: 'ph-core', cx: n.x, cy: n.y, r: 4.5 }, ng);
      }
      if (opts.labels) {
        var gap = opts.big ? 1.6 : 1;
        var t = el('text', { class: 'ph-label', x: n.x, y: n.y + r + 18 * gap, 'text-anchor': 'middle' }, ng);
        t.textContent = n.short;
        var s = el('text', { class: 'ph-sub', x: n.x, y: n.y + r + 33 * gap, 'text-anchor': 'middle' }, ng);
        s.textContent = n.type === 'substation' ? n.capacity + ' kW' : n.demand + ' kW · ' + n.occupancy;
      }
      if (opts.hit && n.type !== 'substation') el('circle', { class: 'ph-hit', cx: n.x, cy: n.y, r: r + 14 }, ng);
      nodes[n.id] = ng;
    });
    return { g: g, nodes: nodes, edges: edges };
  }

  function setState(gr, id, state) {
    var ng = gr.nodes[id];
    var cur = stateOf(gr, id);
    if (cur === state) return;
    ng.classList.remove('ph-reduced', 'ph-dark');
    if (state !== 'ok') ng.classList.add('ph-' + state);
    gr.edges.forEach(function (e) {
      if (e.s !== id && e.t !== id) return;
      var sS = stateOf(gr, e.s), tS = stateOf(gr, e.t);
      e.el.classList.toggle('ph-off', sS === 'dark' || tS === 'dark');
      e.el.classList.toggle('ph-low', sS === 'reduced' && tS !== 'dark');
    });
  }
  function stateOf(gr, id) {
    var c = gr.nodes[id].classList;
    return c.contains('ph-dark') ? 'dark' : c.contains('ph-reduced') ? 'reduced' : 'ok';
  }
  function applyAll(gr, states) { NODES.forEach(function (n) { setState(gr, n.id, states[n.id].state); }); }
  // Round to four places first, as the engine does, so 0.79949 reads 80.0 here and in the console.
  function pct(x) { return (Math.round(Math.round(x * 1e4) / 10) / 10).toFixed(1) + '%'; }
  function fmtK(n) { return n >= 1000 ? (Math.round(n / 100) / 10).toFixed(1) + 'k' : String(n); }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  // ---------- hero controller ----------
  var W = 1600, H = 1000, GW = 1440, GH = 680;
  var LIVE_FULL = 'translate(80px,120px) scale(1)';
  var SM = { s: 0.44, y: 70 }; SM.x = (W - GW * SM.s) / 2;
  var LIVE_SMALL = 'translate(' + SM.x + 'px,' + SM.y + 'px) scale(' + SM.s + ')';
  // One row of policy tracks under a centred, shrunken live campus.
  var TRACK_GAP = 28, TRACK_MARGIN = 50, TRACK_Y = 700;
  var TRACK_W = (W - 2 * TRACK_MARGIN - (POLICIES.length - 1) * TRACK_GAP) / POLICIES.length, TRACK_S = TRACK_W / GW;
  function trackPos(i) { return { x: TRACK_MARGIN + i * (TRACK_W + TRACK_GAP), y: TRACK_Y }; }

  /* opts: onCaption(text), onTick(metrics, tick, total), interactive (click a building to fail it),
     autoplay (default true), par (preserveAspectRatio). Returns {setTick, tick, total, play, pause, reset, fail}. */
  function mountHero(svg, opts) {
    opts = opts || {};
    var reduced = reducedMotion();
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var fit = function () { svg.setAttribute('preserveAspectRatio', opts.par || (document.documentElement.clientWidth < 720 ? 'xMidYMin slice' : 'xMaxYMid meet')); };
    fit(); window.addEventListener('resize', fit);
    ensureStyle(svg);
    if (!reduced) svg.classList.add('ph-anim');
    if (opts.interactive) svg.classList.add('ph-click');
    svg.classList.add('ph-big', 'ph-wide');
    // Labels cannot be read once the diagram is this small, so drop them.
    var bare = function () { svg.classList.toggle('ph-bare', svg.clientWidth > 0 && svg.clientWidth < 520); };
    bare(); window.addEventListener('resize', bare);

    var live = el('g', { class: 'ph-live' }, svg);
    live.style.transformOrigin = '0 0';
    live.style.transform = LIVE_FULL;
    var liveGr = drawGraph(live, { labels: true, big: true, r: 19, hit: !!opts.interactive });

    var branches = el('g', { class: 'ph-branches' }, svg);
    branches.style.opacity = 0;
    var tracks = POLICIES.map(function (p, i) {
      var res = solve(p, SCENARIO), pos = trackPos(i), x = pos.x, y = pos.y;
      var tg = el('g', { class: 'ph-track' }, svg);
      tg.style.opacity = 0; tg.style.transformOrigin = '0 0';
      tg.style.transform = 'translate(' + x + 'px,' + (y + 40) + 'px)';
      el('rect', { class: 'ph-frame', x: -16, y: -16, width: TRACK_W + 32, height: GH * TRACK_S + 32, rx: 4 }, tg);
      var gr = drawGraph(el('g', { transform: 'scale(' + TRACK_S + ')' }, tg), { roads: false, r: 26 });
      applyAll(gr, res.states);
      var num = el('text', { class: 'ph-num', x: 0, y: -62 }, tg);
      num.textContent = pct(res.essential).replace('%', '');
      el('tspan', { class: 'ph-pct', dx: 4 }, num).textContent = '%';
      el('text', { class: 'ph-pol', x: 0, y: -32 }, tg).textContent = p.name;
      el('text', { class: 'ph-meta', x: 0, y: GH * TRACK_S + 44 }, tg).textContent = res.dark + ' dark · ' + fmtK(res.moved) + ' moved';
      var sx = SM.x + SM.s * GW / 2, sy = SM.y + SM.s * GH + 24, ex = x + TRACK_W / 2, ey = y - 124;
      var d = 'M' + sx + ' ' + sy + ' C ' + sx + ' ' + (sy + 90) + ', ' + ex + ' ' + (ey - 90) + ', ' + ex + ' ' + ey;
      var path = el('path', { class: 'ph-branch', d: d }, branches);
      return { g: tg, gr: gr, path: path, res: res, policy: p, x: x, y: y, frame: tg.querySelector('.ph-frame') };
    });
    var best = tracks.slice().sort(function (a, b) { return b.res.essential - a.res.essential || a.res.moved - b.res.moved; })[0];

    var liveRes = solve(POLICIES[0], SCENARIO), order = liveRes.order, N = order.length, TOTAL = N + 4;
    var say = opts.onCaption || function () {};
    var split = false, tick = -1, timer = null, paused = false, userDark = {};

    function showSplit(instant) {
      if (split) return; split = true;
      live.style.transform = LIVE_SMALL; live.classList.add('ph-small');
      branches.style.opacity = 1;
      tracks.forEach(function (t, i) {
        var L = t.path.getTotalLength();
        t.path.style.strokeDasharray = L;
        t.path.style.transition = 'none';
        t.path.style.strokeDashoffset = instant ? 0 : L;
        void t.path.getBoundingClientRect();
        t.path.style.transition = instant ? 'none' : 'stroke-dashoffset .9s ease ' + (0.25 + i * 0.12) + 's';
        t.path.style.strokeDashoffset = 0;
        t.g.style.transitionDelay = instant ? '0s' : (0.9 + i * 0.15) + 's';
        t.g.style.opacity = 1;
        t.g.style.transform = 'translate(' + t.x + 'px,' + t.y + 'px)';
      });
    }
    function hideSplit() {
      if (!split) return; split = false;
      live.style.transform = LIVE_FULL; live.classList.remove('ph-small');
      branches.style.opacity = 0;
      tracks.forEach(function (t) {
        t.g.style.transitionDelay = '0s'; t.g.style.opacity = 0;
        t.g.style.transform = 'translate(' + t.x + 'px,' + (t.y + 40) + 'px)';
        t.path.style.transition = 'none'; t.path.style.strokeDashoffset = t.path.getTotalLength();
      });
    }
    function metrics() {
      var supply = 0, demand = 0, served = 0, ok = 0, red = 0, dark = 0, moved = 0, essDem = 0, essServed = 0;
      NODES.forEach(function (n) {
        var s = stateOf(liveGr, n.id);
        if (n.type === 'substation') { supply += n.capacity * (s === 'reduced' ? SCENARIO[n.feeder] : 1); return; }
        var sv = userDark[n.id] ? 0 : s === 'dark' ? n.demand * liveRes.states[n.id].f : n.demand;
        supply += n.local;
        demand += n.demand; served += sv;
        if (RANK[n.priority] >= 2) { essDem += n.demand; essServed += sv; }
        if (s === 'dark') { dark++; moved += n.occupancy; } else if (s === 'reduced') red++; else ok++;
      });
      return { supply: Math.round(supply + MEDICAL_TIE_KW), demand: demand, served: served, unserved: Math.round(demand - served), ok: ok, reduced: red, dark: dark, moved: moved, essential: essServed / essDem };
    }
    function caption(k) {
      if (k === 0) return 't+0 · campus nominal · all buildings served';
      if (k === 1) return 't+1 · heat wave, 95°F · Central Power Plant at 35%, north feed at 50%';
      if (k <= N + 1) { var n = byId[order[k - 2]]; return 't+' + k + ' · energy agent sheds ' + n.short + ' · transit agent moves ' + n.occupancy; }
      if (k === N + 2) return 'branch · four policies, four copies of the campus, same supply';
      return 'adopt · ' + best.policy.name + ' · ' + pct(best.res.essential) + ' essential demand served';
    }
    function setTick(k, instant) {
      k = Math.max(0, Math.min(TOTAL - 1, k)); tick = k;
      if (instant) svg.classList.add('ph-instant');
      var sub = k >= 1 ? 'reduced' : 'ok';
      setState(liveGr, 'cpp', sub); setState(liveGr, 'north_switch', sub);
      order.forEach(function (id, i) { setState(liveGr, id, i < k - 1 ? 'dark' : 'ok'); });
      Object.keys(userDark).forEach(function (id) { if (userDark[id]) setState(liveGr, id, 'dark'); });
      if (k >= N + 2) showSplit(instant || reduced); else hideSplit();
      tracks.forEach(function (t) { t.frame.classList.toggle('ph-pick', k >= N + 3 && t === best); });
      say(caption(k));
      if (opts.onTick) opts.onTick(metrics(), k, TOTAL);
      if (instant) { void svg.getBoundingClientRect(); svg.classList.remove('ph-instant'); }
    }
    function dur(k) { return k === 0 ? 3000 : k === 1 ? 1100 : k <= N ? 450 : k === N + 1 ? 1000 : k === N + 2 ? 4200 : 3200; }
    function schedule() { clearTimeout(timer); if (paused || reduced) return; timer = setTimeout(function () { setTick((tick + 1) % TOTAL); schedule(); }, dur(tick)); }
    function fail(id) {
      if (byId[id].type === 'substation') return;
      userDark[id] = !userDark[id];
      paused = true; clearTimeout(timer);
      if (tick >= N + 2) tick = N + 1;
      setTick(tick);
      var n = byId[id];
      say(userDark[id] ? 'you failed ' + n.short + ' · transit agent moves ' + n.occupancy + ' people' : 'you restored ' + n.short);
      if (opts.onPause) opts.onPause(true);
    }
    if (opts.interactive) svg.addEventListener('click', function (e) {
      var ng = e.target.closest ? e.target.closest('.ph-node') : null;
      if (ng && live.contains(ng)) fail(ng.getAttribute('data-id'));
    });

    if (reduced) setTick(TOTAL - 1, true);
    else { setTick(0, true); if (opts.autoplay !== false) schedule(); }

    return {
      total: TOTAL, N: N, best: best, tracks: tracks,
      tick: function () { return tick; },
      setTick: function (k, instant) { setTick(k, instant); },
      pause: function () { paused = true; clearTimeout(timer); },
      play: function () { paused = false; schedule(); },
      reset: function () { userDark = {}; paused = false; setTick(0); schedule(); if (opts.onPause) opts.onPause(false); },
      fail: fail
    };
  }

  // Static frames for the four steps. viewBox 1440x680 (+40 margin).
  function drawStep(svg, step) {
    svg.innerHTML = '';
    ensureStyle(svg);
    svg.setAttribute('viewBox', '-40 -40 1520 760');
    if (!reducedMotion()) svg.classList.add('ph-anim');
    var liveRes = solve(POLICIES[0], SCENARIO);
    if (step === 1 || step === 2) {
      var gr = drawGraph(svg, { r: 22 });
      if (step === 1) { setState(gr, 'cpp', 'reduced'); setState(gr, 'north_switch', 'reduced'); }
      else applyAll(gr, liveRes.states);
      return;
    }
    if (step === 4) {
      var S4 = 0.5, g4 = el('g', { transform: 'translate(' + ((1440 - GW * S4) / 2) + ',' + ((680 - GH * S4) / 2) + ')' }, svg);
      el('rect', { class: 'ph-frame ph-pick', x: -28, y: -28, width: GW * S4 + 56, height: GH * S4 + 56, rx: 6 }, g4);
      var bestRes = POLICIES.map(function (p) { return solve(p, SCENARIO); }).sort(function (a, b) { return b.essential - a.essential || a.moved - b.moved; })[0];
      applyAll(drawGraph(el('g', { transform: 'scale(' + S4 + ')' }, g4), { roads: false, r: 22 }), bestRes.states);
      var lab = el('text', { class: 'ph-pol', x: 0, y: -48 }, g4);
      lab.textContent = 'Adopted'; lab.style.fill = 'var(--accent)'; lab.style.fontSize = '34px';
      return;
    }
    var gap = 36, w = (1440 - (POLICIES.length - 1) * gap) / POLICIES.length, S = w / GW, h = GH * S;
    var ox = 0, oy = 380, hub = { x: 720, y: 150 };
    POLICIES.forEach(function (p, i) {
      var res = solve(p, SCENARIO), x = ox + i * (w + gap), y = oy;
      var g = el('g', { transform: 'translate(' + x + ',' + y + ')' }, svg);
      el('rect', { class: 'ph-frame', x: -20, y: -20, width: w + 40, height: h + 40, rx: 6 }, g);
      applyAll(drawGraph(el('g', { transform: 'scale(' + S + ')' }, g), { roads: false, r: 30 }), res.states);
      var tx = x + w / 2, ty = y - 20;
      el('path', { class: 'ph-branch', d: 'M' + hub.x + ' ' + hub.y + ' C ' + hub.x + ' ' + (hub.y + 110) + ', ' + tx + ' ' + (ty - 110) + ', ' + tx + ' ' + ty }, svg);
    });
    el('circle', { cx: hub.x, cy: hub.y, r: 7, fill: 'var(--accent)' }, svg);
  }

export { mountHero as mount, drawStep, solve, pct, fmtK, POLICIES, SCENARIO, NODES };
