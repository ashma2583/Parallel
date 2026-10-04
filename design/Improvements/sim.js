/* PARALLEL prototype engine. Mirrors backend/graph.py + agents in spirit: feeds are hard caps,
   policies decide shed order, agents narrate. window.ParallelSim */
(function () {
  'use strict';
  var NODES = [
    ['cpp', 'Central Power Plant', 'substation', 'none', 'central', 620, 0, 0, 40, 520, 220],
    ['uh', 'University Hospital', 'hospital', 'critical', 'medical', 0, 260, 640, 800, 860, 80],
    ['north_switch', 'North Campus Switching Station', 'substation', 'none', 'north', 560, 0, 0, 12, 1180, 40],
    ['angell', 'Angell Hall', 'academic', 'high', 'central', 0, 90, 0, 400, 220, 80],
    ['shapiro', 'Shapiro Undergraduate Library', 'library', 'low', 'central', 0, 60, 0, 500, 220, 280],
    ['union', 'Michigan Union', 'dining', 'medium', 'central', 0, 50, 0, 350, 40, 180],
    ['ross', 'Ross School of Business', 'academic', 'medium', 'central', 0, 80, 0, 400, 220, 460],
    ['markley', 'Mary Markley Hall', 'dorm', 'high', 'central', 0, 110, 0, 1200, 520, 40],
    ['south_quad', 'South Quad', 'dorm', 'high', 'central', 0, 100, 0, 1100, 40, 400],
    ['mott', "C.S. Mott Children's Hospital", 'hospital', 'critical', 'medical', 0, 190, 0, 420, 860, 280],
    ['kahn', 'Kahn Health Care Pavilion', 'hospital', 'high', 'medical', 0, 150, 150, 300, 1060, 180],
    ['beyster', 'Beyster Building', 'academic', 'high', 'north', 0, 100, 0, 450, 1180, 220],
    ['duderstadt', 'Duderstadt Center', 'library', 'low', 'north', 0, 40, 0, 300, 1400, 120],
    ['pierpont', 'Pierpont Commons', 'dining', 'medium', 'north', 0, 35, 0, 250, 1180, 400],
    ['bursley', 'Bursley Hall', 'dorm', 'high', 'north', 0, 120, 0, 1300, 980, 400],
    ['gg_brown', 'G.G. Brown Laboratories', 'academic', 'medium', 'north', 0, 70, 0, 350, 1400, 300],
    ['ncrc', 'North Campus Research Complex', 'research', 'medium', 'north', 0, 90, 50, 200, 1400, 480],
    ['city_hall', 'Larcom City Hall', 'civic', 'medium', 'city_hall', 0, 25, 40, 80, 40, 620],
    ['blake', 'Blake Transit Center', 'transit', 'low', 'blake', 0, 10, 20, 60, 240, 640],
    ['fire_1', 'Fire Station 1', 'civic', 'high', 'fire_1', 0, 15, 25, 18, 440, 640]
  ].map(function (r) { return { id: r[0], name: r[1], type: r[2], priority: r[3], feeder: r[4], capacity: r[5], demand: r[6], local: r[7], occupancy: r[8], x: r[9], y: r[10] }; });
  var EDGES = [['cpp','angell'],['cpp','shapiro'],['cpp','union'],['cpp','ross'],['cpp','markley'],['cpp','south_quad'],['cpp','uh'],['uh','mott'],['uh','kahn'],['north_switch','beyster'],['north_switch','duderstadt'],['north_switch','pierpont'],['north_switch','bursley'],['north_switch','gg_brown'],['north_switch','ncrc']]
    .map(function (e) { return { id: 'power:' + e[0] + '->' + e[1], source: e[0], target: e[1], type: 'power' }; })
    .concat([['union','angell'],['angell','shapiro'],['shapiro','ross'],['ross','south_quad'],['union','south_quad'],['angell','cpp'],['cpp','markley'],['markley','uh'],['cpp','uh'],['uh','mott'],['uh','kahn'],['mott','kahn'],['union','blake'],['blake','city_hall'],['blake','fire_1'],['north_switch','beyster'],['beyster','duderstadt'],['beyster','pierpont'],['beyster','gg_brown'],['pierpont','bursley'],['gg_brown','ncrc'],['north_switch','ncrc'],['pierpont','blake']]
    .map(function (e) { return { id: 'road:' + e[0] + '->' + e[1], source: e[0], target: e[1], type: 'road' }; }));
  var PLACES = { cpp: ['Central', 'Central Power Plant'], uh: ['Medical', 'University Hospital'], north_switch: ['North', 'North Switching Stn'], angell: ['Central', 'Angell Hall'], shapiro: ['Central', 'Shapiro Library'], union: ['Central', 'Michigan Union'], ross: ['Central', 'Ross School'], markley: ['Central', 'Markley Hall'], south_quad: ['Central', 'South Quad'], mott: ['Medical', "Mott Children's"], kahn: ['Medical', 'Kahn Pavilion'], beyster: ['North', 'Beyster'], duderstadt: ['North', 'Duderstadt'], pierpont: ['North', 'Pierpont Commons'], bursley: ['North', 'Bursley Hall'], gg_brown: ['North', 'G.G. Brown'], ncrc: ['North', 'NCRC'], city_hall: ['Downtown', 'City Hall'], blake: ['Downtown', 'Blake Transit'], fire_1: ['Downtown', 'Fire Station 1'] };
  var ZONES = ['Central', 'Medical', 'North', 'Downtown'];
  var byId = {}; NODES.forEach(function (n) { byId[n.id] = n; });
  var RANK = { low: 0, medium: 1, high: 2, critical: 3, none: -1 };
  function need(n) { return Math.max(0, n.demand - n.local); }

  // Feeds. Medical hangs off University Hospital's own generation; if UH fails, Kahn keeps its 150 kW and Mott goes dark.
  var FEEDS = [
    { id: 'central', sup: 'cpp', members: ['angell', 'shapiro', 'union', 'ross', 'markley', 'south_quad'] },
    { id: 'medical', sup: 'uh', members: ['mott', 'kahn'] },
    { id: 'north', sup: 'north_switch', members: ['beyster', 'duderstadt', 'pierpont', 'bursley', 'gg_brown', 'ncrc'] }
  ];
  var STRATEGIES = [
    { id: 'tiered', label: 'Priority tiers', description: 'Shed the lowest priority tier first. Critical care is never shed.', sort: function (a, b) { return RANK[a.priority] - RANK[b.priority] || need(a) - need(b); } },
    { id: 'residential', label: 'Protect residential', description: 'Keep dorms powered. Academic and commons buildings go dark first.', sort: function (a, b) { return (a.type === 'dorm') - (b.type === 'dorm') || RANK[a.priority] - RANK[b.priority] || need(a) - need(b); } },
    { id: 'academic', label: 'Protect classes', description: 'Keep classrooms and libraries powered. Residence halls go dark first.', sort: function (a, b) { var A = /academic|library/.test(a.type), B = /academic|library/.test(b.type); return A - B || RANK[a.priority] - RANK[b.priority] || need(a) - need(b); } },
    { id: 'people', label: 'Most people per kW', description: 'Shed the buildings that serve the fewest people per kilowatt first.', sort: function (a, b) { return a.occupancy / Math.max(1, need(a)) - b.occupancy / Math.max(1, need(b)); } },
    { id: 'even', label: 'Ration evenly', description: 'No load shedding. Every building on the feed gets the same share.', ration: true }
  ];
  var SCENARIOS = [
    { id: 'heat', label: 'Heat wave, 95°F', detail: 'Power plant at 35%, north feed at 50%', reason: 'Heat wave derates campus generation', steps: [{ ids: ['cpp'], action: 'derate', factor: 0.35 }, { ids: ['north_switch'], action: 'derate', factor: 0.5 }] },
    { id: 'cpp', label: 'Central Power Plant trips', detail: 'Central campus loses its only feed', reason: 'Central campus generation trips offline', steps: [{ ids: ['cpp'], action: 'fail' }] },
    { id: 'north', label: 'North campus feed opens', detail: 'Only NCRC has generation of its own', reason: 'DTE campus substation feed opens', steps: [{ ids: ['north_switch'], action: 'fail' }] },
    { id: 'uh', label: 'Hospital switchgear fails', detail: 'Medical campus falls back to the emergency tie', reason: 'University Hospital intake fails', steps: [{ ids: ['uh'], action: 'fail' }] },
    { id: 'all', label: 'All three intakes drop', detail: 'Regional outage', reason: 'All three campus intakes drop', steps: [{ ids: ['cpp', 'uh', 'north_switch'], action: 'fail' }] }
  ];

  /* disruption: { failed: {id:true}, derate: {id: factor} } -> nodes with currentPower/status/loadShed, plus shed log */
  function evaluate(disruption, strategyId) {
    var strat = STRATEGIES.filter(function (s) { return s.id === strategyId; })[0] || STRATEGIES[0];
    var out = {}, log = [];
    NODES.forEach(function (n) { out[n.id] = { id: n.id, failed: !!disruption.failed[n.id], factor: disruption.derate[n.id] == null ? 1 : disruption.derate[n.id], served: 0, local: 0 }; });
    FEEDS.forEach(function (f) {
      var sup = byId[f.sup], so = out[f.sup];
      var cap = sup.type === 'substation' ? sup.capacity : sup.local;
      var supply = so.failed ? 0 : cap * so.factor;
      var members = f.members.map(function (id) { return byId[id]; }).filter(function (m) { return !out[m.id].failed; });
      if (sup.type !== 'substation') { // UH serves itself first
        var own = Math.min(supply, so.failed ? 0 : sup.demand);
        so.served = own; supply -= own;
      } else so.served = supply;
      var total = members.reduce(function (a, m) { return a + need(m); }, 0);
      members.forEach(function (m) { out[m.id].local = Math.min(m.local, m.demand); out[m.id].served = out[m.id].local; });
      if (total <= supply) { members.forEach(function (m) { out[m.id].served = m.demand; }); return; }
      var short = total - supply;
      if (strat.ration) {
        var share = supply / total;
        members.forEach(function (m) { out[m.id].served = out[m.id].local + need(m) * share; });
        log.push({ agent: 'Energy agent (' + cap1(f.id) + ')', text: Math.round(short) + ' kW short, every building on the feed at ' + Math.round(share * 100) + '%' });
        return;
      }
      var shed = [], remaining = total;
      members.slice().sort(strat.sort).forEach(function (m) {
        if (remaining <= supply || m.priority === 'critical' || need(m) === 0) return;
        var gap = remaining - supply;
        if (need(m) <= gap + 1e-9) { out[m.id].served = out[m.id].local; remaining -= need(m); shed.push(m.name + ' off'); }
        else { var cut = gap / need(m); out[m.id].served = out[m.id].local + need(m) * (1 - cut); remaining -= gap; shed.push(m.name + ' -' + Math.round(cut * 100) + '%'); }
      });
      members.forEach(function (m) { if (out[m.id].served === out[m.id].local && shed.indexOf(m.name + ' off') < 0 && remaining <= supply) out[m.id].served = m.demand; });
      // members not shed get full
      var sheddedNames = shed.map(function (s) { return s.split(' off')[0].split(' -')[0]; });
      members.forEach(function (m) { if (sheddedNames.indexOf(m.name) < 0) out[m.id].served = m.demand; });
      if (remaining > supply + 1e-6) log.push({ agent: 'Energy agent (' + cap1(f.id) + ')', text: 'critical load exceeds supply by ' + Math.round(remaining - supply) + ' kW' });
      if (shed.length) log.push({ agent: 'Energy agent (' + cap1(f.id) + ')', text: Math.round(short) + ' kW short, shed ' + shed.join(', ') });
    });
    // self-supplied nodes
    ['city_hall', 'blake', 'fire_1'].forEach(function (id) { var n = byId[id]; out[id].served = out[id].failed ? 0 : Math.min(n.local, n.demand) + (n.local >= n.demand ? 0 : 0); if (!out[id].failed) out[id].served = n.demand; });
    var nodes = NODES.map(function (n) {
      var o = out[n.id], supplier = n.type === 'substation';
      var ratio = supplier ? (o.failed ? 0 : o.factor) : n.demand > 0 ? o.served / n.demand : 1;
      var status = o.failed ? 'Red' : ratio >= 0.99 ? 'Green' : ratio > 0.02 ? 'Amber' : 'Red';
      return { id: n.id, name: n.name, short: PLACES[n.id][1], zone: PLACES[n.id][0], type: n.type, priority: n.priority, capacity: n.capacity, demand: n.demand, occupancy: n.occupancy, x: n.x, y: n.y, failed: o.failed, currentPower: supplier ? (o.failed ? 0 : n.capacity * o.factor) : o.served, powerRatio: Math.max(0, Math.min(1, ratio)), loadShed: supplier ? 0 : Math.max(0, 1 - ratio), status: status };
    });
    return { nodes: nodes, log: log, strategy: strat.id };
  }
  function cap1(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function metrics(nodes) {
    var cons = nodes.filter(function (n) { return n.type !== 'substation'; });
    function served(list) { var w = list.reduce(function (a, n) { return a + n.demand; }, 0); return w ? list.reduce(function (a, n) { return a + n.currentPower; }, 0) / w : 1; }
    var dark = cons.filter(function (n) { return n.status === 'Red'; }), amber = cons.filter(function (n) { return n.status === 'Amber'; });
    return {
      essential_served: served(cons.filter(function (n) { return n.priority === 'critical' || n.priority === 'high'; })),
      critical_served: served(cons.filter(function (n) { return n.priority === 'critical'; })),
      total_served: served(cons),
      supply: nodes.reduce(function (a, n) { return a + (n.type === 'substation' ? n.currentPower : Math.min(byId[n.id].local, n.demand)); }, 0),
      demand: cons.reduce(function (a, n) { return a + n.demand; }, 0),
      unserved: cons.reduce(function (a, n) { return a + Math.max(0, n.demand - n.currentPower); }, 0),
      people_relocated: dark.reduce(function (a, n) { return a + n.occupancy; }, 0),
      people_reduced_power: amber.reduce(function (a, n) { return a + n.occupancy; }, 0),
      buildings_dark: dark.length,
      counts: { Green: cons.filter(function (n) { return n.status === 'Green'; }).length + nodes.filter(function (n) { return n.type === 'substation' && n.status === 'Green'; }).length, Amber: nodes.filter(function (n) { return n.status === 'Amber'; }).length, Red: nodes.filter(function (n) { return n.status === 'Red'; }).length }
    };
  }
  function zoneLoads(nodes) {
    return ZONES.map(function (z) {
      var m = nodes.filter(function (n) { return n.type !== 'substation' && n.zone === z; });
      var w = m.reduce(function (a, n) { return a + n.demand; }, 0);
      return { zone: z, served: w ? m.reduce(function (a, n) { return a + n.currentPower; }, 0) / w : 1, dark: m.filter(function (n) { return n.status === 'Red'; }).length };
    });
  }
  // Transit agent: move people out of dark buildings to the nearest lit building reachable by road.
  function transitMoves(nodes) {
    var st = {}; nodes.forEach(function (n) { st[n.id] = n; });
    var adj = {}; EDGES.forEach(function (e) { if (e.type !== 'road') return; (adj[e.source] = adj[e.source] || []).push(e.target); (adj[e.target] = adj[e.target] || []).push(e.source); });
    var moves = [];
    nodes.filter(function (n) { return n.type !== 'substation' && n.status === 'Red' && n.occupancy > 0; }).forEach(function (n) {
      var seen = {}, q = [n.id], dest = null; seen[n.id] = true;
      while (q.length && !dest) { var cur = q.shift(); (adj[cur] || []).forEach(function (nb) { if (seen[nb] || dest) return; seen[nb] = true; var m = st[nb]; if (m.type !== 'substation' && m.status === 'Green' && /dorm|dining|academic|library/.test(m.type)) dest = m; else q.push(nb); }); }
      if (!dest) dest = nodes.filter(function (m) { return m.status === 'Green' && m.type !== 'substation' && m.id !== n.id; })[0];
      if (dest) moves.push({ agent: 'Transit agent', text: 'moved ' + n.occupancy + ' from ' + n.name + ' to ' + dest.name, from: n.id, to: dest.id });
    });
    return moves;
  }
  function briefing(nodes, strategyId, disrupted, heat) {
    var dorms = nodes.filter(function (n) { return n.type === 'dorm'; }), classes = nodes.filter(function (n) { return /academic|library/.test(n.type); });
    var lit = function (l) { return l.filter(function (n) { return n.status !== 'Red'; }).reduce(function (a, n) { return a + n.occupancy; }, 0); };
    var darkNodes = nodes.filter(function (n) { return n.status === 'Red' && n.type !== 'substation'; });
    var ans = { tiered: 'Shed by priority. Critical care, then dorms and classrooms, hold as long as the feed allows.', residential: 'Keep dorms lit. Classrooms and commons on a short feed are shut first.', academic: 'Keep classes lit. Residence halls on a short feed are shut first.', people: 'Keep the buildings that hold the most people per kilowatt. Low-occupancy loads go first.', even: 'No one goes dark. Every building on a short feed runs on a reduced share.' }[strategyId];
    var skips = darkNodes.map(function (n) { return n.short; });
    return {
      disrupted: disrupted,
      displaced: darkNodes.reduce(function (a, n) { return a + n.occupancy; }, 0),
      priority: { answer: disrupted ? ans : 'Nothing to decide. Every building is served.', dorms_lit: lit(dorms), classrooms_lit: lit(classes) },
      buses: { answer: darkNodes.length ? 'Yes. Do not unload at a dark stop. Hold riders for the next lit stop on that route.' : 'No. All stops are lit.', reroute: darkNodes.length ? [{ agency: 'U-M', name: 'Bursley Baits', skip: skips.filter(function (s) { return /Pierpont|Bursley/.test(s); }), keep: ['Bursley Hall', 'Pierpont Commons'].filter(function (k) { return skips.indexOf(k) < 0; }) }, { agency: 'U-M', name: 'Commuter North', skip: skips.filter(function (s) { return /Union|Markley|Pierpont|Angell/.test(s); }), keep: ['Angell Hall', 'University Hospital', 'Duderstadt'].filter(function (k) { return skips.indexOf(k) < 0; }) }, { agency: 'U-M', name: 'Commuter South', skip: skips.filter(function (s) { return /Pierpont|Markley|South Quad|Union/.test(s); }), keep: ['Duderstadt', 'University Hospital'].filter(function (k) { return skips.indexOf(k) < 0; }) }].filter(function (r) { return r.skip.length; }) : [] },
      cooling: { answer: heat && darkNodes.length ? 'Yes. Open Michigan Union and Pierpont Commons as cooling centers while they are lit.' : heat ? 'Not yet. Every building still has power.' : 'No. There is no heat emergency.', open: heat && darkNodes.length > 0, places: heat && darkNodes.length ? ['union', 'pierpont'].filter(function (id) { return nodes.filter(function (n) { return n.id === id; })[0].status === 'Green'; }) : [] },
      systems: [
        { system: 'Hospital', status: nodes.filter(function (n) { return n.id === 'uh'; })[0].status === 'Red' ? 'down' : 'up', detail: nodes.filter(function (n) { return n.id === 'uh'; })[0].status === 'Red' ? 'Intake failed. Mott is on the emergency tie.' : 'On its own generation. Critical care unaffected.' },
        { system: 'Transit', status: 'up', detail: darkNodes.length ? darkNodes.length + ' stops dark, routes adjusted.' : 'All routes running.' },
        { system: 'Research', status: nodes.filter(function (n) { return n.id === 'ncrc'; })[0].status === 'Red' ? 'down' : 'up', detail: nodes.filter(function (n) { return n.id === 'ncrc'; })[0].status === 'Red' ? 'NCRC dark. 50 kW of local generation holds freezers only.' : 'NCRC holding on local generation.' }
      ]
    };
  }
  function runBranches(disruption) {
    return STRATEGIES.map(function (s) { var r = evaluate(disruption, s.id); var m = metrics(r.nodes); return { id: s.id, label: s.label, description: s.description, nodes: r.nodes, metrics: m, log: r.log }; });
  }
  function best(branches) { return branches.slice().sort(function (a, b) { return b.metrics.essential_served - a.metrics.essential_served || a.metrics.people_relocated - b.metrics.people_relocated; })[0].id; }
  function fmtPeople(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
  function points(r) { return Math.round(r * 1000) / 10; }

  window.ParallelSim = { NODES: NODES, EDGES: EDGES, PLACES: PLACES, ZONES: ZONES, STRATEGIES: STRATEGIES, SCENARIOS: SCENARIOS, byId: byId, evaluate: evaluate, metrics: metrics, zoneLoads: zoneLoads, transitMoves: transitMoves, briefing: briefing, runBranches: runBranches, best: best, fmtPeople: fmtPeople, points: points };
})();
