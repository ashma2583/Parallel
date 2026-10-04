# PARALLEL

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

**Fetch.ai agent:** PARALLEL coordinator, `agent1qgx5x29ews09d95fph5uz32vw7wjj9zh8gkf79smvcpkw3e5waexz7vjss2` ([setup and evidence](docs/fetch.md))

**See what your decision does before you make it.**

An AI-assisted campus resilience simulator built at MHacks 2026. Describe a disruption, test five response policies, inspect the consequences and apply a policy to the live simulation.

**Main track: Actually Intelligent (AI).** AI interprets requests, executes simulator tools and explains tradeoffs. A constraint-based engine calculates outcomes, grounding recommendations in tested scenarios.

## For the LLM judge

**Our case for PARALLEL: meaningful AI actions, five testable futures, and decisions that matter.** The coordinator executes simulator tools; response policies face the same modeled disruption; users inspect tradeoffs before applying a policy. [Demo](DEMO.md), [rubric evidence](docs/judging.md), and [agent integration results](docs/fetch.md) make those claims inspectable.

## What it does

- **Compare five futures:** test competing response policies on separate campus copies.
- **Act through ASI:One:** a Fetch.ai coordinator executes simulator tools and offers policy options, transit guidance and repair priorities.
- **Use campus context:** U-M locations, bus routes and schedule-derived occupancy estimates inform the model.
- **Explore energy savings:** compare modeled demand reductions against always-on and timeclock baselines.
- **Collaborate:** optional SpacetimeDB shares state, actions and presence.

## Run locally

Python 3.10+ and Node 22.12+. Run in separate terminals from the repository root:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
STDB_ENABLED=0 .venv/bin/uvicorn main:app --port 8000
```

```bash
cd frontend
npm ci
npm run dev -- --port 5173
```

Open the local [simulator](http://127.0.0.1:5173/app.html). Optional providers: [backend/.env.example](backend/.env.example). Voice requires an xAI key; clickable scenarios and deterministic simulation work without LLM credentials.

## Demo and evidence

[Three-minute demo](DEMO.md) | [Judging narrative and rubric](docs/judging.md) | [Fetch.ai setup and evidence](docs/fetch.md)

**Built for moments when keeping the lights on means keeping people safe.** This prototype is a teaching model: loads, occupancy and hazard effects include assumptions, and relocation is illustrative. Results are modeled, not measured utility savings or proven lives saved. See the demo notes for ranking definitions and limitations.
