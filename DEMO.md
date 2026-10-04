# PARALLEL demo

## Start it
The final build is already running on **http://127.0.0.1:5173/app.html**: engine on 8000, frontend on 5173. To start it yourself:

```bash
cd backend && STDB_ENABLED=0 .venv/bin/uvicorn main:app --port 8000
```
```bash
cd frontend && npx vite --port 5173
```
Use `127.0.0.1` or `localhost`, so the microphone works.

**Fetch.ai agent** (a separate process; the console doesn't need it):
```bash
cd backend && FETCH_CHAT=1 ENGINE_URL=http://127.0.0.1:8000 .venv/bin/python -m agents.asi_bureau
```
The agent is **PARALLEL Coordinator**, address `agent1qgx5x29ews09d95fph5uz32vw7wjj9zh8gkf79smvcpkw3e5waexz7vjss2`. Its mailbox connects automatically. In ASI:One, give it that address explicitly.

**SpacetimeDB multiplayer:** the local server runs on :3000 with the `parallel` database. Start the engine with `STDB_ENABLED=1 STDB_DATABASE=parallel` and open two windows; the top bar shows "2 online". If the engine isn't publishing, the app ignores the stale data and uses the engine.

**LLM fallbacks:** parsing and the plans, verdict and debrief use Grok first, then Claude, then deterministic text. The Fetch.ai agent uses ASI:One, then Grok, then Claude. The demo keeps working if one provider is down. Voice transcription is Grok only.

## Main pitch (under 3 minutes)

**Built for moments when keeping the lights on means keeping people safe.** PARALLEL is a campus resilience simulator for safer decisions and smarter energy use.

Use this sequence for the main judging panel: problem and campus (20 s), one scenario (30 s), compare five policies and apply one (50 s), Balanced energy saver and its timeclock baseline (40 s), limitations and closing (25 s). Keep ASI:One and multiplayer for sponsor demonstrations. The longer walkthrough below is also useful for recording a separate sponsor video.

The console ranks final outcomes by people in powered shelters, then fewer people left dark, then shelter power. The ASI:One Energy Planner separately prioritizes essential service. Adoption applies a policy to the live simulation; it does not replace the campus with the projected branch end state.

## Extended walkthrough (about 4 minutes)
1. **Hook (15 s).** "PARALLEL is a digital twin of the University of Michigan campus: 20 real buildings on the 3 real power feeds, the real U-M bus routes, and the real Fall 2026 class schedule. You throw a disaster at it and see what your decision does before you make it."
2. **The map (30 s, Duke + bottleOfVacuum).** Open **Ann Arbor**.
   - Buses move along the real routes; their icons follow the streets in 2D and 3D.
   - Yellow People circles show students in class right now.
   - Zoom out to the national view with school logos, then click the U-M logo (or pick University of Michigan) to fly back.
3. **Plan a storm and compare before it hits (60 s).** Click the **Tornado** pill and drag a path from South Quad through Markley. Add **Extreme cold** from the strip.
   - Press **Compare all five policies**: each policy plays your planned scenario on its own copy *before* anything hits the live campus.
   - Pick the best, press **Adopt**, then **Run**: buses close as red dashes, power lines are cut, and the feed shows the energy and transit agents responding.
4. **Heat wave (45 s, ashma).** Open **Heat wave demo**.
   - The top-bar clock runs 4 minutes per second and plant output falls over 4 hours.
   - GO · COOL and LEAVE rings show where to go. Compare the policies through the heat peak and Adopt.
   - As evening comes, the map turns to night.
5. **Energy saver (30 s).** In the strip, set **Energy saver** to Balanced.
   - CAP tags appear on empty buildings, and the counter shows kWh saved.
   - It uses the class schedule and caps at or above modeled occupied need. Savings are modeled demand reductions, not measured utility savings; compare against the timeclock baseline as well as always-on.
   - **Details** opens the building-by-time heatmap and "what we learned".
6. **People drive decisions (15 s).** In the **People** tab, agents use schedule-derived occupancy estimates. A failure at 14:00 can affect different numbers of people than the same failure at 20:00.
7. **Ask an agent (30 s, Fetch.ai).** In ASI:One: "an ice storm hit North Campus, what should we do?" It runs the options through the simulator and replies with ranked options from the Energy, Transit and Repair-crew planners. Then say "adopt 1".
8. **Multiplayer (15 s, optional).** With two windows side by side, an action in one appears instantly in the other.

## Honest notes for judges
- **Real data:**
  - building locations and campus infrastructure context (feed connections are simplified);
  - U-M and TheRide GTFS bus routes;
  - the Fall 2026 class schedule and campus events;
  - FEMA and NOAA hazard frequencies;
  - live NWS conditions.
- **Modelled:**
  - kilowatts are a scaled demo model;
  - storm effects follow written rules (overhead vs underground lines, direct hits);
  - energy-saver base loads and occupancy turnout are labelled assumptions;
  - relocation is illustrative, without travel-time or shelter-capacity constraints;
  - response comparisons report final outcomes, not cumulative exposure or lives saved.

## Morning-of checklist
1. Fetch.ai: start the agent (above), test it in ASI:One with the address, then register with the MHacks ASI:One submission agent.
2. Optional: `spacetime login`, then publish to maincloud for hosted multiplayer.
3. Record the video and submit to Devpost by noon EDT on October 4, the conservative deadline in the supplied event briefing (which notes a conflicting 12:15 listing). Include the table number and all teammates, and register the Devpost link in the MHacks dashboard. Fetch.ai additionally requests a public shared chat, Agentverse profile, repository instructions and a 3-5 minute video through its separate submission workflow.
