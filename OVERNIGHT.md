# Overnight log

Read this first. It records what ran, what passed, what was reverted, and which commit is the demo build.

**Branch:** `hazards-and-locations`, local only, nothing pushed.
**Test stack:** engine on :8300, frontend on :5300. The usual 8000 and 5173 were left alone.

## Demo build
_Not chosen yet. This becomes the newest commit whose gates all pass._

## Teammate branch tips merged
Recorded 03:20 after `git fetch`. Anything newer gets merged on top before the demo.

| Branch | Tip | Notes |
|---|---|---|
| origin/heat-wave-demo | c6944fe | Includes main and sustainability. New since planning: "voice" (logic.py, voice.py, UI touch-ups) |
| origin/duke/design_improvements | b404c17 | New since planning: day/night map themes, picking a campus preview from the map location, compact school markers, `CityCanvas.tsx` |
| origin/human-flow | b46671a | Occupancy by time of day |
| origin/hazards-and-locations | 266b0ce | Base of this branch |

## Phases
### Phase 0: setup (done, 03:20)
- Removed the scratch `integrate` worktree and branch.
- Regression baseline screenshots (grid, briefing, plan, map, disrupted map, Branch; light and dark) have no console errors.
- Snapshot commit `88db217`: the weather scenario composer.

### Phase 1: composer finish (running since 03:21)
Four builders work in parallel: wiring and strip, compact dock, hook fixes, backend fixes. Then a QA panel of five lenses (flows, visual, backend, regression, chaos) checks the result, with each finding verified before it is fixed, until two rounds come back clean.

### Sponsor spikes (running since 03:26, in an isolated worktree `../MHacks2026-sponsors`)
- Early feasibility checks with measured evidence: SpacetimeDB two-way sync, and the Fetch.ai Agentverse mailbox plus ASI:One. Phases 5 and 6 port the parts that are proven to work.
- A SpacetimeDB standalone server was already running on :3000 (started 01:30, not by this run). It has no `parallel` database, so the spike publishes under `parallel-spike` and leaves everything else alone.
- Added to Phases 4–6: **"Describe a scenario"** (plain language to a scenario plan) using the Claude API key, with Grok as a fallback.

### Sponsor spikes: done (04:07)
Full reports are in the scratchpad: `spike-stdb-report.md` and `spike-fetch-report.md`.

**Fetch.ai: L1–L4 all work.**
- ASI:One `asi1-mini` parses scenarios as JSON 10/10, median 0.58 s.
- Coordinator agent `agent1qgx5x29ews09d95fph5uz32vw7wjj9zh8gkf79smvcpkw3e5waexz7vjss2` uses the chat protocol and publishes its manifest.
- **The mailbox connects automatically with the API key. No browser click needed: 3 of 3 restarts.**
- Agentverse search ranks it first for "PARALLEL Coordinator".
- ASI:One reached it 4 of 4 times (7.6–11.3 s end to end). The demo should give ASI:One the agent's address explicitly; found by name alone, it took 78 s.
- `COORDINATOR_SEED` is copied into `backend/.env.local`. Keep it, because the address and listing depend on it.

**SpacetimeDB: L1–L3 work locally. L4 (hosted) is blocked until you run `spacetime login`.**
- Presence p95 25 ms.
- Actions through SpacetimeDB: 0 lost and 0 duplicated over 250+ actions, including bursts from 3 windows. Another window sees an action in about 10–18 ms; it's applied in about 230 ms.
- The REST fallback works when the SpacetimeDB server dies, and clients reconnect on their own after it restarts.
- **Gotcha for the morning:** the spike's local publish saved a local-only identity in `~/.config/spacetime/cli.toml`. If you run `spacetime login`, local databases owned by that identity may become read-only to the CLI. Log in before republishing, or publish under a fresh name. The test database `parallel-spike` can be deleted: `spacetime delete parallel-spike -s local`.

## Morning sprint: final state (10:02)
**Demo build: `dfb21e8` on `hazards-and-locations`.** It's running on 8000/5173. 69 backend tests pass and the typecheck is clean.
- **Merged:**
  - ashma's heat wave, clock, seasons, plans and verdict;
  - bottleOfVacuum's People data, which now drives sim occupancy and the agents' context;
  - Duke's map: campus picker, national logos, moving buses;
  - SpacetimeDB presence and actions (flag-gated, and the app ignores stale data);
  - the Fetch.ai coordinator (reachable from ASI:One);
  - compare before it hits;
  - the energy saver toggle;
  - LLM fallbacks (Grok/ASI:One, then Claude, then deterministic);
  - the port fix;
  - the one-clock change, and day to night on the map;
  - City view and step bar removed.
- **Not done:**
  - storms played tick by tick on the engine (Phase 3; storms still play in the browser, while the heat wave is tick-based);
  - a preset scenario library;
  - a deep performance pass;
  - the 10x demo rehearsal and soak test.
- **All side worktrees were removed**, and the merged branches deleted. Nothing was pushed.
