# PARALLEL: judging narrative

**See what your decision does before you make it.**

## Problem and purpose

Campuses need to reduce avoidable energy demand on ordinary days and preserve essential services during disruptions. PARALLEL makes the consequences of a response visible before a user commits to it.

## What we built

A campus resilience teaching simulator informed by University of Michigan locations, bus routes and class schedules. Users compose disruptions, run five response policies on separate copies of the campus, inspect modeled outcomes and apply a policy. An energy saver uses occupancy estimates, headroom and preconditioning to explore demand reductions against always-on and timeclock baselines.

## Why it is distinctive

**The demonstration is a decision, not just an outage animation.** Competing policies face comparable campus states and the same disruption. The engine calculates power and population outcomes; language models interpret commands and explain simulator results. A Fetch.ai coordinator provides meaningful simulator tool execution through ASI:One, while optional SpacetimeDB collaboration shares state and actions.

| Criterion | What to show |
| --- | --- |
| Innovation | One disruption, five simulated responses, visible tradeoffs before policy adoption. |
| Technical Complexity | Constraint-based graph simulation, time-dependent occupancy, hazard effects, branching, agent tools and shared state. |
| Usability | Scenario composition, comparable outcomes, direct policy adoption and readable explanations. |
| Adherence to Theme | Sustainability through energy conservation and resilience; growth through better data and validated models. |

## Evidence the reviewer can inspect

Follow [DEMO.md](../DEMO.md) for the short live demonstration and [README.md](../README.md) for setup and source links. Compare essential demand served, shelter population, people left dark and relocations. Show energy-saver results against the timeclock baseline with the assumptions visible. [Fetch.ai evidence](fetch.md) records integration test conditions and example conversations.

The console ranks powered-shelter population, then fewer people dark, then shelter power. The ASI:One Energy Planner separately ranks essential service, then fewer people dark, then fewer relocations. Adoption applies a response policy to the live simulation.

## Impact and limits

**Built for moments when keeping the lights on means keeping people safe.** The intended impact is better preparation and less avoidable energy use. Current outcomes are modeled, not measured utility savings or proven lives saved. Loads, turnout, electrical connections and hazard effects include simplifying assumptions. Relocation is illustrative; response comparisons score final outcomes rather than cumulative exposure.

The next step is validation with metered loads, shelter capacities and observed response data. The main-track framing is **Sustainability**. Submit sponsor entries only with their required working integrations and public evidence.
