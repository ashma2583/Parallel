# PARALLEL repository guide

PARALLEL is an AI-assisted campus resilience teaching simulator built at MHacks 2026. Its main-track framing is Actually Intelligent (AI): interpret requests, execute simulator tools and explain tested outcomes.

## Start here

- Project overview, setup and evidence: `README.md`.
- Judging narrative and rubric mapping: `docs/judging.md`.
- Live demonstration: `DEMO.md`.
- Fetch.ai coordinator setup: `docs/fetch.md`.
- Simulation and branching: `backend/graph.py`, `backend/branch.py`.
- Occupancy and energy assumptions: `backend/occupancy.py`, `backend/savings.py`.

## Working conventions

- Check Git status and preserve unrelated local work. Use the current branch unless instructed otherwise.
- Keep presentation-only edits separate from simulation behavior changes.
- Describe modeled results as modeled, schedule-derived headcounts as estimates, and enabled integrations accurately.
- The console ranks powered-shelter population, then fewer people dark, then shelter power. The ASI:One Energy Planner separately ranks essential service, then fewer people dark, then fewer relocations. Preserve that distinction in explanations.
- Validate frontend changes with `cd frontend && npm run build`.
- Read `backend/spacetimedb/AGENTS.md` before changing that module.
- Do not commit credentials, local archives, extracted design exports or scratch files.
