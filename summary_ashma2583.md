# ashma2583 — features to merge

Owner: ashma2583
Branch: `heat-wave-demo`
Base commit on the branch: `8c9054c` (`Merge the console UI with the sustainability desk.`)
Status: the heat-wave demo work below is **uncommitted** in the working tree. Do not drop it because it is not in a commit yet.

The console shell from `main` stays: landing page, TopBar, Schematic grid, Ann Arbor map, LivePanel, BranchPanel, Inspector. Do not bring back `CampusMap`, `CampusNode`, `ControlPanel`, `StatusBar`, or `VoicePanel`.

## 1. Heat-wave demo entry

The home page does not auto-start an outage.

- **Run a scenario** goes to `/app`. The campus is whatever the engine is doing. Pause, the tick, and Go stay in the header.
- **Heat wave demo** goes to `/app?demo=heat-wave`. That calls `POST /heat-wave`, resets first if the campus is already disrupted, and leaves the live side panel open.

Files: `frontend/index.html`, `frontend/src/landing/landing.css`, `frontend/src/App.tsx`, `frontend/src/components/ScenarioStrip.tsx` (`HEAT_WAVE`, `runScenario`).

## 2. The heat wave builds over four hours

It does not snap the plant to 35% on the next tick.

- `POST /heat-wave` arms the ramp and unpauses the clock. `CampusGraph.start_heat_wave` / `advance_heat_wave` in `backend/graph.py`.
- 60 ticks. One tick is 4 minutes. Full span is 4 hours.
- Each tick moves Central Power Plant linearly from 100% toward 35%, and the north feed from 100% toward 50%.
- Buildings stay lit while supply is still enough, then go dark one by one as the shortage grows (about 90 minutes in, under the tiered policy).
- The banner above the grid shows elapsed time and the plant’s current output. At the peak it says the plant is at 35%.
- Clock rewind stores `derate` and `heat_wave` on each frame (`backend/agents/runtime.py`). Playing forward continues the ramp from the restored step.
- The policy comparison does not wait. `POST /branch` runs each policy through the **peak** (`through_peak`) while the live clock stays earlier.

## 3. A heat wave opens cooling centers

Fall / winter / spring still use warming centers when no heat wave is armed. An active `graph.heat_wave` forces cooling even if `runtime.season` is fall.

- Shelters are dining, library, and City Hall (`briefing._shelter`, `_is_shelter`).
- Map and grid pins say **GO · COOL**. Dark buildings say **LEAVE**.
- `POST /branch` returns `shelter: "cooling" | "warming"`.
- Rank policies by people in a lit shelter, then fewer people still in a dark building, then kilowatts at those shelters.
- Metrics on each branch: `people_in_shelter`, `shelter_kw`, `people_dark`, plus the older essential-served numbers.
- `POST /verdict` writes one paragraph from those counts. If the model is down, `verdict_from_numbers` in `backend/voice.py` is the fallback. A heat wave must be described as cooling centers.

## 4. Sidebar attention, only in the demo

`?demo=heat-wave` adds a pulsing left edge on the side panel (`.demo-rail`) and a pulsing **Compare all five policies** button (`.demo-button`).

- First note, on the live panel: Briefing is where people should go and which buses still run; Agent feed is the agents; then compare the five policies.
- Second note, on the branch list: hover to preview the peak, **Best** is the most people in a cooling center, Adopt applies it to the live grid.
- Either note dismisses with ×. The normal `/app` path has neither note.

Files: `frontend/src/components/LivePanel.tsx`, `frontend/src/components/BranchPanel.tsx`, `frontend/src/index.css`.

## 5. Agent feed keeps a log per scenario

The old 12-line cap is gone.

- `runtime.begin_scenario(label)` archives the current log and starts a new one.
- Called for a heat wave (`Heat wave, 95°F`), a reset (`Campus reset`), and a disrupt (the reason, or the action plus node ids).
- Adopting a policy stays inside the current scenario.
- Up to 8 archived scenarios are kept, plus the live one. `snapshot()` and `GET /state` include `scenarios: [{id, label, lines, ticks}]`.
- The Agent feed lists every line. If more than one scenario exists, each is a button at the top of the feed.

Files: `backend/agents/runtime.py`, `backend/main.py`, `frontend/src/lib/sim.ts`, `frontend/src/components/LivePanel.tsx`.

## 6. Grid can be moved, and the type is larger

- Schematic: drag to pan, scroll to zoom, double-click to reset. Hint sits at the bottom left.
- Building names, kilowatt lines, and GO / LEAVE labels are larger. GO / LEAVE stays visible even when the diagram is narrow.
- The page root is 14px, so sidebar sizes are explicit: briefing body 16px, section titles 18px, policy name and branch title 22px.
- Ann Arbor marker labels and the GO / COOL tag are larger too.

Files: `frontend/src/components/Schematic.tsx`, `frontend/src/components/GeoMap.tsx`, `frontend/src/components/BriefingPanel.tsx`, `frontend/src/components/LivePanel.tsx`, `frontend/src/components/BranchPanel.tsx`, `frontend/src/App.tsx`.

## 7. What the merge commit already carried in

`8c9054c` put the earlier sustainability desk onto the new console. Keep these if a partner’s branch was cut before that merge:

- Seasons and warming vs cooling shelters when there is **no** heat wave.
- Five written response plans and “Try this allocation”, behind **More** in the header. They adopt `tiered | residential | academic | people | even`.
- U-M building planner: pin, move, confirm, per-building remove. Other-campus research with a role graph. Both live on the Plan tab, also behind **More**.
- Tick history: Pause, type a tick, Go. Forward and back. A jump pauses.
- Map opacity slider, U-M-only bus lines, stable legend, red dashed gap where a served stop is dark, “use” on lines that still have a lit stop.
- 3D buildings on the Ann Arbor map, behind **More**.

**More** still hides the plan tab, the voice box, the 3D toggle, and the five written plans. The clock is always visible.

## Merge notes

- Treat an instant `derate` of `cpp` to 0.35 as the old heat wave. The button and the demo must call `/heat-wave`.
- Do not key cooling centers only on `season == "summer"` while a heat wave is armed.
- Do not put the agent log back on a 12-line deque.
- Branch rows are scored by people in a shelter, not by essential-demand percent alone.
- Kilowatts are a scaled model. The three intakes, the buildings, and the U-M bus lines are the real parts. Leave that sentence on the heat-wave banner and the branch footer.
