/* Shared console state + actions for the city views. Mixed into a DC logic class.
   window.ParallelHUD.install(Component) ; this.hudVals(S, colors) inside renderVals. */
(function () {
  'use strict';
  var GEO = { cpp: [-83.7364, 42.282], uh: [-83.7286, 42.2836], north_switch: [-83.7048, 42.2976], angell: [-83.7394, 42.2769], shapiro: [-83.737, 42.2755], union: [-83.7416, 42.2752], ross: [-83.7383, 42.2709], markley: [-83.7298, 42.2807], south_quad: [-83.7368, 42.2736], mott: [-83.7262, 42.2827], kahn: [-83.7236, 42.2839], beyster: [-83.7161, 42.2927], duderstadt: [-83.7156, 42.2911], pierpont: [-83.7178, 42.2914], bursley: [-83.7202, 42.2948], gg_brown: [-83.7138, 42.2933], ncrc: [-83.6925, 42.3052], city_hall: [-83.7486, 42.2813], blake: [-83.7483, 42.2786], fire_1: [-83.7484, 42.2817] };
  var TYPE_LABEL = { substation: 'Feed', hospital: 'Hospital', dorm: 'Dorm', dining: 'Commons', library: 'Library', transit: 'Transit', academic: 'Academic', research: 'Research', civic: 'City' };
  var PRI = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', none: 'Supply' };

  function initialState() {
    return { disruption: { failed: {}, derate: {} }, scenario: null, strategy: 'tiered', selectedId: null, branching: false, openBranch: null, preview: null, adopted: false, tick: 0, activity: [], heat: false, command: '', heard: '', ready: !!window.ParallelSim };
  }
  var methods = {
    hudMount: function () {
      var self = this;
      var boot = function () { if (window.ParallelSim) self.setState({ ready: true }); else setTimeout(boot, 50); };
      requestAnimationFrame(boot);
      this.tickTimer = setInterval(function () { self.setState(function (s) { return { tick: s.tick + 1 }; }); }, 1000);
      this.onKey = function (e) { if (e.key === 'Escape') self.setState({ branching: false, preview: null, selectedId: null }); };
      window.addEventListener('keydown', this.onKey);
    },
    hudUnmount: function () { clearInterval(this.tickTimer); window.removeEventListener('keydown', this.onKey); },
    log: function (lines) { var t = 't' + this.state.tick; this.setState(function (s) { return { activity: s.activity.concat(lines.map(function (l) { return { t: t, line: l }; })) }; }); },
    apply: function (disruption, strategy, extra) {
      var S = window.ParallelSim, r = S.evaluate(disruption, strategy), moves = S.transitMoves(r.nodes);
      this.setState({ disruption: disruption, strategy: strategy });
      this.log((extra || []).concat(r.log.map(function (l) { return l.agent + ': ' + l.text; }), moves.map(function (m) { return m.agent + ': ' + m.text; })));
    },
    cloneD: function () { return { failed: Object.assign({}, this.state.disruption.failed), derate: Object.assign({}, this.state.disruption.derate) }; },
    playScenario: function (sc) {
      var d = this.cloneD();
      sc.steps.forEach(function (st) { st.ids.forEach(function (id) { if (st.action === 'fail') d.failed[id] = true; else d.derate[id] = st.factor; }); });
      this.setState({ heat: this.state.heat || sc.id === 'heat', scenario: sc, adopted: false });
      this.apply(d, this.state.strategy, ['Director: ' + sc.reason]);
    },
    toggleNode: function (id) {
      var d = this.cloneD(), n = window.ParallelSim.byId[id];
      if (d.failed[id]) { delete d.failed[id]; this.apply(d, this.state.strategy, ['Director: restored ' + n.name]); }
      else { d.failed[id] = true; delete d.derate[id]; this.setState({ scenario: this.state.scenario || { label: 'Manual override', detail: n.name + ' failed' } }); this.apply(d, this.state.strategy, ['Director: manual override, failed ' + n.name]); }
    },
    adopt: function (id) {
      var S = window.ParallelSim, label = S.STRATEGIES.filter(function (s) { return s.id === id; })[0].label;
      this.apply(this.state.disruption, id, ["Coordinator: adopted policy '" + label + "'. The live campus now follows it."]);
      this.setState({ branching: false, preview: null, adopted: true });
    },
    reset: function () { this.setState({ disruption: { failed: {}, derate: {} }, scenario: null, heat: false, activity: [{ t: 't' + this.state.tick, line: 'Director: campus reset' }], selectedId: null, branching: false, preview: null, adopted: false }); },
    send: function () {
      var t = this.state.command.trim().toLowerCase(); if (!t) return;
      var S = window.ParallelSim, heard = 'no action', self = this;
      var hit = S.NODES.filter(function (n) { return t.indexOf(n.name.toLowerCase().split(' ')[0]) >= 0 || (n.id === 'cpp' && /power plant|plant/.test(t)) || (n.id === 'north_switch' && /north/.test(t)) || (n.id === 'uh' && /hospital/.test(t)); });
      if (/reset/.test(t)) { this.reset(); heard = 'reset campus'; }
      else if (hit.length) { var d = this.cloneD(), restore = /restore|back/.test(t); hit.forEach(function (n) { if (restore) delete d.failed[n.id]; else d.failed[n.id] = true; }); this.setState({ scenario: this.state.scenario || { label: 'Director’s order', detail: this.state.command } }); this.apply(d, this.state.strategy, ['Director: ' + this.state.command]); heard = (restore ? 'restore ' : 'fail ') + hit.map(function (n) { return n.id; }).join(', '); }
      this.setState({ command: '', heard: heard });
    },
    /* Returns { nodes (shown, preview-aware), liveNodes, vals } */
    hudVals: function (S, c) {
      var self = this, st = this.state;
      var liveNodes = S.evaluate(st.disruption, st.strategy).nodes, m = S.metrics(liveNodes);
      var nodes = st.preview ? S.evaluate(st.disruption, st.preview).nodes : liveNodes;
      var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
      var SC = { Green: c.powered, Amber: c.reduced, Red: c.dark };
      var disrupted = Object.keys(st.disruption.failed).length > 0 || Object.keys(st.disruption.derate).length > 0;
      var ess = m.essential_served, essColor = ess >= 0.999 ? c.powered : ess >= 0.8 ? c.reduced : c.dark;
      var sel = st.selectedId ? byId[st.selectedId] : null, selVals = null;
      if (sel) { var sup = sel.type === 'substation', color = SC[sel.status]; selVals = { name: sel.name, kind: TYPE_LABEL[sel.type] + ' · ' + PRI[sel.priority] + ' priority · ' + sel.zone, color: color, statusLabel: sel.failed ? 'Offline' : ({ Green: 'Full power', Amber: 'Reduced', Red: 'Dark' })[sel.status], rows: [{ label: sup ? 'Output' : 'Receiving', value: Math.round(sel.currentPower) + ' kW' }, { label: sup ? 'Capacity' : 'Wants', value: Math.round(sup ? sel.capacity : sel.demand) + ' kW' }, { label: 'People', value: sel.occupancy.toLocaleString() }], btnLabel: sel.failed ? 'Restore this node' : 'Fail this node', btnColor: sel.failed ? c.powered : c.dark }; }
      var AC = { Energy: c.line, Transit: c.reduced, Coordinator: c.accent, Director: c.text };
      var feed = st.activity.slice().reverse().map(function (a) { var i = a.line.indexOf(':'), who = i > 0 ? a.line.slice(0, i) : 'System'; return { t: a.t, who: who, color: AC[who.split(' ')[0]] || c.muted, text: i > 0 ? a.line.slice(i + 1).trim() : a.line }; });
      var stepIdx = !disrupted ? 0 : st.branching ? 2 : st.adopted ? 3 : 1;
      var steps = ['Break', 'Watch', 'Branch', 'Adopt'].map(function (label, i) { var cur = i === stepIdx, done = i < stepIdx; return { n: i + 1, label: label, notLast: i < 3, onClick: function () { if (i >= 2 && disrupted) self.setState({ branching: true }); if (i === 1) self.setState({ branching: false }); }, color: cur || done ? c.text : c.muted, ringColor: cur || done ? c.accent : c.hair, numBg: done ? c.accent : 'transparent', numColor: done ? c.onAccent : cur ? c.accent : c.muted, bg: cur ? c.ground : 'transparent' }; });
      var branches = [], identical = false, branchIntro = '';
      if (st.branching) {
        var res = S.runBranches(st.disruption), winner = S.best(res), live = res.filter(function (b) { return b.id === st.strategy; })[0];
        identical = new Set(res.map(function (b) { return JSON.stringify(b.metrics); })).size === 1;
        branchIntro = 'Forked at t' + st.tick + '. Each policy ran 6 ticks on its own copy of the campus with the same agents and supply. The live campus has not changed.';
        var openId = st.openBranch || winner;
        branches = res.map(function (b, i) {
          var bm = b.metrics, isLive = b.id === st.strategy, isBest = b.id === winner && !identical, open = b.id === openId, hovered = st.preview === b.id;
          var delta = S.points(bm.essential_served) - S.points(live.metrics.essential_served), ec = bm.essential_served >= 0.999 ? c.powered : bm.essential_served >= 0.8 ? c.reduced : c.dark;
          return { id: b.id, label: b.label, description: b.description, delay: (i * 60) + 'ms', isLive: isLive, isBest: isBest, open: open, edge: open ? c.accent : hovered ? c.muted : 'transparent', bg: open ? c.ground : 'transparent', ess: S.points(bm.essential_served), essColor: ec, barW: (bm.essential_served * 100) + '%', dark: bm.buildings_dark, darkColor: bm.buildings_dark ? c.dark : c.text, moved: S.fmtPeople(bm.people_relocated), reduced: S.fmtPeople(bm.people_reduced_power), reducedColor: bm.people_reduced_power ? c.reduced : c.text, showDelta: !isLive && Math.abs(delta) >= 0.05, delta: (delta > 0 ? '+' : '−') + Math.abs(delta).toFixed(1), deltaColor: delta > 0 ? c.powered : c.dark,
            rows: [{ label: 'Critical care served', value: S.points(bm.critical_served) + '%', color: bm.critical_served < 0.999 ? c.dark : c.text }, { label: 'All demand served', value: S.points(bm.total_served) + '%', color: c.text }, { label: 'People relocated', value: S.fmtPeople(bm.people_relocated), color: c.text }],
            btnLabel: isLive ? 'Running on the live campus' : 'Adopt this timeline', btnBorder: isLive ? c.hair : c.accent, btnBg: isLive ? 'transparent' : c.accent, btnColor: isLive ? c.muted : c.onAccent,
            onHover: function () { self.setState({ preview: b.id }); }, onLeave: function () { self.setState({ preview: null }); }, onSelect: function () { self.setState({ openBranch: b.id }); }, onAdopt: isLive ? null : function (e) { e.stopPropagation(); self.adopt(b.id); } };
        });
      }
      var pol = S.STRATEGIES.filter(function (s) { return s.id === st.strategy; })[0];
      var previewPol = st.preview ? S.STRATEGIES.filter(function (s) { return s.id === st.preview; })[0] : null;
      var vals = {
        ready: true, tick: st.tick, steps: steps,
        essentialPct: Math.round(ess * 100) + '%', essentialColor: essColor, supplyKw: Math.round(m.supply) + ' kW', demandKw: Math.round(m.demand) + ' kW', unservedKw: Math.round(m.unserved) + ' kW', unservedColor: m.unserved >= 1 ? c.dark : c.text,
        pristine: !disrupted, disrupted: disrupted, scenarioLabel: st.scenario ? st.scenario.label : 'Disrupted', scenarioDetail: st.scenario ? st.scenario.detail : '', previewing: !!previewPol, previewName: previewPol ? previewPol.label : '',
        scenarios: S.SCENARIOS.map(function (sc) { return { label: sc.label, detail: sc.detail, onClick: function () { self.playScenario(sc); } }; }), reset: function () { self.reset(); },
        hasSelection: !!sel, sel: selVals, toggleSelected: function () { if (sel) self.toggleNode(sel.id); }, clearSelection: function () { self.setState({ selectedId: null }); },
        liveMode: !st.branching, branching: st.branching, policyName: pol.label, policyDesc: pol.description,
        openBranch: function () { self.setState({ branching: true, openBranch: null }); }, closeBranch: function () { self.setState({ branching: false, preview: null }); },
        branchHint: disrupted ? 'Forks the campus and runs each policy 6 ticks on its own copy.' : 'Break something first. With every building served, all five policies end in the same place.',
        feed: feed, feedEmpty: feed.length === 0,
        command: st.command, setCommand: function (e) { self.setState({ command: e.target.value }); }, commandKey: function (e) { if (e.key === 'Enter') self.send(); }, sendCommand: function () { self.send(); }, sendOpacity: st.command.trim() ? 1 : 0.3, heard: st.heard,
        branches: branches, identical: identical, branchIntro: branchIntro,
        zones: S.zoneLoads(nodes).map(function (z) { var color = z.served >= 0.9 ? c.powered : z.served >= 0.5 ? c.reduced : c.dark; return { zone: z.zone, pct: Math.round(z.served * 100) + '%', color: color, width: (z.served * 100) + '%' }; })
      };
      return { nodes: nodes, liveNodes: liveNodes, byId: byId, SC: SC, vals: vals };
    }
  };
  window.ParallelHUD = { GEO: GEO, initialState: initialState, install: function (C) { Object.assign(C.prototype, methods); } };
})();
