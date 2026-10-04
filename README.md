# PARALLEL

## See what your decision does before you make it.

**Built for moments when keeping the lights on means keeping people safe.** PARALLEL is a campus resilience simulator for safer decisions and smarter energy use, built at MHacks 2026.

Rehearse a disruption, compare five response policies on separate copies of the same campus, and apply a policy to the live simulation. On ordinary days, explore schedule-aware energy conservation with headroom and preconditioning instead of treating every building as permanently busy.

**Main track: Sustainability.** The project connects energy conservation with climate resilience. AI interprets requests, executes simulator tools and explains tradeoffs; the constraint engine calculates the outcomes.

### Try the demonstration

After setup, open the local [landing page](http://127.0.0.1:5173/) or [simulator](http://127.0.0.1:5173/app.html). These addresses require the services below running on your computer; they are not hosted public demos.

- [Three-minute pitch and demo walkthrough](DEMO.md)
- [Judging narrative and evidence](docs/judging.md)
- [Fetch.ai / ASI:One setup and documented integration tests](docs/fetch.md)

### Why it matters

The central question is practical: **which response preserves useful service under the same disruption and limited power supply?** A visually dramatic outage is only the starting point. PARALLEL makes competing responses inspectable before the user commits to one.

| Judging criterion | Implemented evidence |
| --- | --- |
| Innovation | Five policy branches run from comparable campus states, with the same scenario and supply. See [branch.py](backend/branch.py). |
| Technical Complexity | A graph-based power model, changing occupancy, rule-based hazard effects, energy/transit agents and meaningful coordinator tool execution. See [graph.py](backend/graph.py), [runtime.py](backend/agents/runtime.py) and [planners.py](backend/agents/planners.py). |
| Usability | Draw scenarios, inspect consequences, compare outcomes and apply a response visually. See [BranchPanel.tsx](frontend/src/components/BranchPanel.tsx) and [DEMO.md](DEMO.md). |
| Adherence to Theme | Schedule-aware energy conservation and campus resilience; a model that can grow through validated data and new scenarios. See [savings.py](backend/savings.py). |

### Reproduce the evidence

1. Open the heat-wave demo and compare the five policies. Inspect essential demand served, people in powered shelters, people left dark and relocations. The console ranks final outcomes by powered-shelter population, then fewer people dark, then shelter power.
2. Apply a policy. Adoption changes the live response policy; it does not replace live state with the branch's projected end state.
3. Reset and enable Balanced energy saver. Open Details to compare modeled demand reductions against both always-on and a simple timeclock baseline. The timeclock comparison shows the additional benefit of schedule-aware control.
4. Review the displayed assumptions. The results are simulation outputs, not measured campus savings or demonstrated lives saved.

The ASI:One Energy Planner uses a separate objective: essential service, then fewer people dark, then fewer relocations. Those rankings answer different questions and should not be presented as identical.

### Run locally

Prerequisites: Python 3.10+ and a Node/npm version supported by Vite 8 (Node 22.12+). From the repository root:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
STDB_ENABLED=0 .venv/bin/uvicorn main:app --port 8000
```

In another terminal:

```bash
cd frontend
npm ci
npm run dev -- --port 5173
```

Clickable scenarios and the deterministic simulator work without LLM credentials. Voice requires an xAI key. Optional provider configuration is described in [backend/.env.example](backend/.env.example); keep credentials in local environment files and out of Git.

**Fetch.ai:** a separate coordinator speaks the Agent Chat Protocol, executes simulator tools and can be reached through ASI:One while its process is running. It uses three specialist planning functions, rather than three separately deployed chat agents. Follow [docs/fetch.md](docs/fetch.md) for mailbox configuration and example conversations.

**SpacetimeDB:** an optional collaboration backend for shared state, presence and actions. It requires a running SpacetimeDB server, the published `parallel` module and a backend started with `STDB_ENABLED=1 STDB_DATABASE=parallel`. Verify it is enabled before demonstrating multiplayer; the REST engine works independently.

### Source-backed context, explicit assumptions

Source inputs include campus building locations, GTFS bus routes, Fall 2026 class schedules and campus events, FEMA/NOAA hazard context, and NWS weather when available. Saved datasets support repeatable demonstrations.

**Modeled:** simplified electrical connections, demo-scale power loads, occupancy derived from schedules and assumed turnout, building-type activity patterns, written storm-effect rules and illustrative relocation. Relocation does not model travel time or shelter capacity. Response comparison metrics describe final outcomes rather than cumulative exposure. Energy caps cover modeled occupied need; that is not a validated building-control safety guarantee.

### Validation and growth

```bash
cd frontend && npm run build
```

Existing backend checks are in [test_savings.py](backend/test_savings.py), [test_occupancy.py](backend/test_occupancy.py) and [test_llm.py](backend/test_llm.py). Integration test results and their run conditions are documented in [docs/fetch.md](docs/fetch.md).

Next steps are validation against metered loads, shelter capacities and observed response data, plus cumulative exposure metrics. **The ambition is safer decisions and less avoidable energy use; today's evidence is a working, inspectable teaching model.**
