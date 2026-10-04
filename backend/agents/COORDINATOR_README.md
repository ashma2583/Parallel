# PARALLEL Coordinator

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)
![ASI:One](https://img.shields.io/badge/ASI%3AOne-chat-000000)

Coordinator agent for **PARALLEL**, a live digital twin of the University of Michigan campus
power, transit and repair network (MHacks 2026).

Describe a storm or an equipment failure and it runs the scenario through the simulator,
then answers with options the simulator actually tested, ranked by essential load served
and people left in the dark. Three specialists weigh in:

- **Energy Planner** ranks the load-shedding policies.
- **Transit Planner** says which bus lines to reroute, which shelters to open, and where the students in each dark building should go.
- **Repair Crew** says which failed node to restore first, ranked by the students in class there now.

The student counts come from the simulator's class schedule at the campus clock's time of day (`GET /people/now`).

Try:

- "An ice storm hit North Campus, what should we do?"
- "A tornado touched down"
- "The central power plant just tripped offline"
- "adopt 1" (apply an option), "status" (live picture), "reset" (clear the campus)

It speaks the Agent Chat Protocol and only answers while the team's laptop is running it.
