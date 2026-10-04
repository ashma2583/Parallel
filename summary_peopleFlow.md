# People flow

Estimates how many people are in each campus building at a time of day. The number is for the map only. It is not written into the simulation's node occupancy.

Two sources are added together:

- **Classes.** Fall 2026 Schedule of Classes. A person counts only while their section is meeting: `seats = capacity`, or enrollment when the section is over capacity, then `present = round(seats * turnup)`. Default turnup is 0.75.
- **Events.** Happening @ Michigan for the week of 2026-10-05. The feed has no attendance, so each event type uses a fixed crowd size (a lecture is 80, a performance is 200, a sporting event is 500). All-day listings count from 10:00 to 17:00.

Online sections, TBA rooms, and events with no matched building are dropped. Cross-listed classes that share a room and time are stored once.

## Layout

| Piece | Role |
| --- | --- |
| `backend/occupancy.py` | Term selection, Schedule of Classes client, building match, and the 8:00–22:00 projection (every 30 minutes). |
| `backend/events.py` | Reads the Happening snapshot, matches venue names to buildings, and turns each occurrence into a meeting. |
| `backend/data/fall-2026-class-load.json` | Demo class snapshot. 3,505 placed meetings, Fall 2026 term `2610`. |
| `backend/data/fall-2026-events.json` | Demo event snapshot for the week of 2026-10-05. |
| `backend/data/class-schedule.json` | Optional live cache. Gitignored. Used only when it is under 6 hours old. |
| `GET /occupancy?weekday=&turnup=` | Returns slots, per-building series, and coordinates. `students` on a slot is classes plus events. `events` is the event portion. |
| `frontend/src/components/ClassLoad.tsx` | Weekday, turnup, and time controls. Pushes the selected slot to the map. |
| `frontend/src/components/GeoMap.tsx` | Maize circles sized against the day's busiest building. The bottom slider scrubs the time. |

`snapshot()` loads classes, loads events, and calls `project()`. Buildings that correspond to a simulation pin (`NODE_BY_CODE` in `occupancy.py`) use that pin's coordinates. Other buildings use the public campus map.

## Demo

The API prefers a fresh `class-schedule.json`, then the committed class snapshot, and calls the Schedule of Classes API only when neither file is available. Events always come from `fall-2026-events.json`.

```bash
cd backend && STDB_ENABLED=0 .venv/bin/uvicorn main:app --port 8000
cd frontend && npm run dev
```

Open the app, choose **Ann Arbor**, and move the time slider. `UM_CLIENT_ID` and `UM_CLIENT_SECRET` are only needed to refresh the class file.
