# Fetch.ai: PARALLEL Coordinator

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

**Agent name:** PARALLEL Coordinator
**Address:** `agent1qgx5x29ews09d95fph5uz32vw7wjj9zh8gkf79smvcpkw3e5waexz7vjss2`
**Inspector:** https://agentverse.ai/inspect/?uri=http%3A//127.0.0.1%3A8120&address=agent1qgx5x29ews09d95fph5uz32vw7wjj9zh8gkf79smvcpkw3e5waexz7vjss2

A uAgent that speaks the Agent Chat Protocol, so ASI:One and any other Agentverse
chat client can ask it about campus storms. It is a separate process: it talks to the
PARALLEL engine over HTTP and never runs inside it.

## Example prompts

- `An ice storm hit North Campus, what should we do?`
- `A tornado touched down near North Campus`
- `The central power plant just tripped offline`
- `adopt 1` (apply option 1 on the live campus)
- `status` (live supply, demand, failed nodes, displaced people)
- `reset` (clear the campus)
- `help`

## What it does

```
message -> ack straight away
        -> ASI:One asi1-mini parses it (8 s cap, keyword fallback if it is slow or down)
        -> POST /hazards/apply {id}   or   POST /disrupt {node_ids, action: "fail"}
        -> POST /branch {ticks: 8}
        -> reply: top 3 policies ranked by essential_served, then people_dark
"adopt N" -> POST /strategy {strategy}   (option 4: POST /disrupt restore)
          -> live summary from /state and /briefing
```

Every number in a reply comes from the simulator. ASI:One only parses the request and
writes a two-sentence headline; a headline that contains a number the simulator did not
produce is thrown away and replaced by a template.

Three specialists are named in each answer (logic in `backend/agents/planners.py`):

| Specialist | Proposes | Source |
|---|---|---|
| Energy Planner | the ranked load-shedding policies (options 1 to 3) | `POST /branch` |
| Transit Planner | which bus lines to reroute, which shelters to open | `GET /briefing` |
| Repair Crew | which failed node to restore first (option 4, `adopt 4`) | `GET /state` |

## Run

From `backend/`, with the engine already running:

```bash
FETCH_CHAT=1 ENGINE_URL=http://127.0.0.1:8000 .venv/bin/python -m agents.asi_bureau
```

Stop it with Ctrl-C (SIGINT). That marks the agent inactive in the Almanac; `kill -9` leaves it listed as active.

`backend/.env.local` needs (never commit it):

| Variable | Purpose |
|---|---|
| `COORDINATOR_SEED` | Fixes the address. Keep the same seed, a new one gives a new address and loses the mailbox, profile and search ranking. |
| `ASI_ONE_API_KEY` | ASI:One parsing and headlines. Blank is fine: keyword parsing and templated headlines take over. |
| `AGENTVERSE_API_KEY` | Creates the Agentverse mailbox on startup, no browser click. Needed once per address. |

Optional: `ASI_MODEL` (default `asi1-mini`), `AGENTVERSE_AUTOCONNECT` (default `1`),
`COORDINATOR_PORT` (default `8120`), `ENGINE_URL` (default `http://127.0.0.1:8000`).
`.env.example` should list `COORDINATOR_SEED=`, `ASI_ONE_API_KEY=`, `AGENTVERSE_API_KEY=`,
`ASI_MODEL=asi1-mini` and `AGENTVERSE_AUTOCONNECT=1`.

On startup the log shows the address, "Successfully registered as mailbox agent in
Agentverse" and "Agentverse autoconnect: success=True". `GET http://127.0.0.1:8120/health`
reports the same. The "not enough funds to register on Almanac contract" warnings are
harmless; registration through the Almanac API succeeds.

If the laptop sleeps and WSL drifts, `sudo hwclock -s` fixes the clock (mailbox
signatures are only valid for 1000 s).

## Test

```bash
# terminal 1 (engine on 8000 or any port, coordinator on 8130 here)
FETCH_CHAT=1 ENGINE_URL=http://127.0.0.1:8000 COORDINATOR_PORT=8130 .venv/bin/python -m agents.asi_bureau

# terminal 2: 8 scripted conversations, straight to the coordinator
ENGINE_URL=http://127.0.0.1:8000 .venv/bin/python -m agents.chat_test_client --route local
# the same flow through the Agentverse mailbox, the way ASI:One reaches it
ENGINE_URL=http://127.0.0.1:8000 .venv/bin/python -m agents.chat_test_client --route mailbox --cases 3,5 --port 8132
# ASI:One itself reaches the coordinator by address (planner mode)
.venv/bin/python -m agents.asi_one_reach "An ice storm hit North Campus, what should we do?"
```

The client checks each reply and the engine state it should have caused (failed nodes,
strategy in force, top option matching a fresh `/branch`). It resets the engine between
cases, and leaves it clean. The eight conversations are: ice storm, tornado, power plant
trips then `adopt 4`, status, `adopt 1`, `adopt 2`, reset, and nonsense (which must not touch
the campus). Do not run it against an engine someone is demoing on.

Last run, engine on 8350:

| Route | Conversations | Result | Reply latency |
|---|---|---|---|
| local | 8 (13 steps) | 13/13 pass | median 2.2 s, p95 3.2 s, max 4.2 s |
| mailbox | 2 (4 steps) | 4/4 pass | median 5.8 s, p95 8.1 s |
| ASI:One planner mode | 1 | reached, 3 messages answered | 33 s end to end |

The acknowledgement arrives in about 0.2 s on the local route. For a smooth live demo,
send the first message a minute early so the engine and ASI:One are warm, and give the
address to ASI:One explicitly (by name alone it can take over a minute and call other agents).

## Files

- `backend/agents/asi_bureau.py`: the agent (chat protocol, mailbox autoconnect, flow)
- `backend/agents/planners.py`: Energy Planner, Transit Planner and Repair Crew as plain functions
- `backend/agents/COORDINATOR_README.md`: the Agentverse profile (carries the badges)
- `backend/agents/chat_test_client.py`: scripted conversations
- `backend/agents/asi_one_reach.py`: ASI:One reaches the agent by address
