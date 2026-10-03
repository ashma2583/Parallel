# System Context & Role
You are an expert full-stack developer and system architect. We are building "PARALLEL," a 24-hour hackathon MVP of a digital twin campus simulator. We are optimizing for a highly visual, stable, deterministic demo, prioritizing core mechanics and API integrations over edge cases.

## 1. Product Overview
PARALLEL is an interactive graph simulation of a university campus. A user acts as the Emergency Director and speaks a disruption scenario into a microphone. The simulation graph dynamically reacts, autonomous agents negotiate for scarce resources, and the system generates a photorealistic visual Situation Report (SitRep) of the damage.

## 2. Tech Stack & Constraints
- **Frontend:** React, TailwindCSS, React-Flow (for a clean 2D node-based campus map).
- **Backend/Simulation Engine:** Python (FastAPI).
- **State Synchronization:** SpacetimeDB (to push real-time tick updates to the frontend).
- **Agent Orchestration:** FetchAI (uAgents framework).
- **Voice Interface:** Grok Voice API (`grok-voice-transcribe-2.0` for Speech-to-Text).
- **Generative Visuals:** Grok Imagine API (`grok-imagine-image-2.0` for photorealistic drone feed generation).
- **LLM Policy Parsing:** Gemini API (converts transcribed text into JSON).
- **Strict Rule:** Do not overengineer. Mock complex physics. Use a simple discrete-event tick loop for the simulation engine.

## 3. The Data Model (MVP Scope)
Hardcode a static graph of exactly 15 nodes representing a university campus:
- **Nodes:** 2 Substations, 1 Hospital (Critical), 4 Dorms (High Priority), 2 Dining Halls (Med Priority), 1 Library (Low Priority), 5 Transit Stops.
- **Node State:** Each node tracks 3 variables: `current_power`, `occupancy`, and `status` (Green, Amber, Red).
- **Edges:** Represent power lines and roads connecting the nodes.

## 4. Agent Behaviors (FetchAI)
Implement 3 discrete agents that interact with the simulation state:
1. **Coordinator Agent (LLM):** Takes the parsed JSON policy matrix and triggers the timeline branch.
2. **Energy Agent:** Reads the priority matrix. In a deficit, it programmatically sheds load from low-priority nodes to maintain Critical nodes.
3. **Transit Agent:** Monitors node `status`. If a node turns 'Red' (power failure), it automatically moves `occupancy` numbers to the nearest 'Green' node.

## 5. Execution Plan (Step-by-Step)
Do not write all phases at once. Await my approval after each phase before proceeding.

* **Phase 1: Core Engine:** Initialize the Python FastAPI backend. Create `graph.py` to define the 15 nodes and a deterministic `tick()` function that calculates resource deficits.
* **Phase 2: State Sync:** Set up the SpacetimeDB schema and connect the Python backend so it publishes the graph state every 1 second.
* **Phase 3: The Map UI:** Scaffold the React frontend. Use React-Flow to render the 15 nodes. Connect to SpacetimeDB so the nodes change color instantly when the state updates.
* **Phase 4: FetchAI Agents:** Write the uAgents scripts. Connect the Energy and Transit agents to the simulation loop so they dynamically update node states based on deficits.
* **Phase 5: Voice Command Interface (Grok Voice):** Add a "Push to Talk" microphone button to the React UI using the browser's MediaRecorder API. When the user stops recording, POST the audio blob to the xAI API using the `grok-voice-transcribe-2.0` model. Pass the transcribed text string into the Gemini API to output a structured JSON policy payload, and feed that to the Coordinator agent.
* **Phase 6: Visual SitRep Engine (Grok Imagine):** When a major node turns 'Red' (e.g., Hospital loses power), have the Python backend asynchronously fire a prompt to the `grok-imagine-image-2.0` endpoint (e.g., "Photorealistic drone footage of a modern university hospital at night during a total blackout, ominous, cinematic"). When the API returns the image URL, trigger a "Live Camera Feed" modal on the React frontend to display the generated crisis photo.