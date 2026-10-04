# Claude Design prompt: PARALLEL landing page

Attach every other file in this folder, then paste everything below the line.

---

Design the landing page for PARALLEL and hand it back as a zip.

## The app

PARALLEL is a live simulation of the University of Michigan campus power grid, built at MHacks 2026. It is for campus emergency managers who must run a response exercise every year, and for the instructors who teach emergency management and planning. Students and hackathon judges will also land here.

Core loop:

1. Break something. Trip the Central Power Plant, or start a heat wave that cuts it to 35%.
2. Watch it cascade. Twenty real buildings on three real feeds react. An energy agent sheds load, a transit agent moves people out of dark buildings. Nothing is scripted and no agent can invent power that is not there.
3. Branch the timeline. The engine forks the campus and runs four response policies on separate copies.
4. Compare and adopt. The outcomes sit side by side (essential demand served, people relocated, buildings dark). Pick one and the live campus switches to it.

The honest limit, which the page must state once in plain words: this is a constraint-based teaching model, not a forecast of the real grid.

## Attached context

- `01-console-nominal.png`: the console with the grid balanced.
- `02-console-heat-wave.png`: the same console after the heat wave scenario.
- `03-branch-timeline.png`: four policies compared side by side. This is the product's centerpiece.
- `04-ann-arbor-map.png`: the same state on a real map.
- `campus-graph.json`: the actual 20 nodes and 38 edges (power lines and roads) with layout positions, demand in kW, and occupancy. Draw the hero from this, not from an invented network.
- `tokens.css`: the app's current colour and type tokens.

The screenshots show how the app works today. They are context, not a style to copy. Do not paste them into the page as images.

## Single job of the page

Get the visitor to run a scenario. One primary action, "Run a scenario", repeated down the page. It links to `/app`.

## Platform

Web only, desktop first. The page must still read well on a phone.

## Hero

Show the core loop as an animation, drawn in SVG from `campus-graph.json`:

- The campus one-line diagram sits calm, current moving along the power lines.
- One feed fails. The lines it serves go dark and the buildings on them drop out, one after another.
- The timeline then splits into parallel tracks. Each track settles into a different end state with a different number on it.

It loops, it is the hero's background and subject at once, and the headline sits on top of it. NOT a floating mockup, not a screenshot in a browser frame.

The headline states the offer in one sentence. Something in the territory of "See what your decision does before you make it." Write your own.

## Sections below the hero

Keep it short. Each section answers a doubt a visitor actually has:

- "What do I do with it?" The four steps of the core loop, shown, not listed as cards.
- "Is the comparison real?" Show one branch comparison with the real policy names: Priority tiers, Protect residential, Most people per kW, Ration evenly.
- "Can I trust the numbers?" The honest limit above, plus what is real: real buildings, real feed topology, hard supply constraints.
- A closing call to action.

No filler feature grid. No testimonials, client logos, or usage numbers: we have none, so do not invent any. Where a real fact is missing, leave a visibly marked placeholder like [CONTACT EMAIL].

## Look

Futuristic, in the sense of a control room or an instrument, not a sci-fi poster. It should feel engineered and calm. It must not look AI-generated or like a generic startup page.

Palette, dark and light mode both required:

| Role | Dark | Light |
|---|---|---|
| Ground | `#090b0f` | `#f3f4f1` |
| Panel | `#0f1217` | `#fbfbf9` |
| Hairline | `#222832` | `#d9dcd6` |
| Text | `#ece9e2` | `#12151a` |
| Muted text | `#8f95a1` | `#5a616d` |
| Accent (branching, the one call to action) | `#a48bff` | `#5b3fd6` |
| Powered | `#3ddc97` | `#0f9d63` |
| Reduced | `#ff8a3d` | `#d9650d` |
| Dark building | `#ff5d5d` | `#d93a3a` |
| Live power line | `#cfe3ff` | `#3b5b8c` |

No maize and no yellow anywhere. The attached screenshots use a yellow-amber for the reduced state and for live power lines. On this page use the orange and the cool line colour from the table instead.

Violet is reserved for branching and the call to action. Green, orange and red mean building state only and are never decoration.

Type: IBM Plex Sans for text and IBM Plex Mono for every number, matching the app. If you want a display face for the headline, propose one and say why.

## Motion

Spend it on the hero. Below the hero, at most a quiet reveal as sections enter. Respect `prefers-reduced-motion` with a still frame of the hero.

## Voice

Calm, exact, plain. Short sentences. Say what the thing does. No em-dashes anywhere in the copy.

## Avoid

Floating angled mockup, gradient blobs, 3-card feature grid, bento grid, startup gradient, generic "trusted by" wall, emoji, glow on everything, cards with a coloured left border.

## Deliverable

A zip containing a fluid, responsive page as plain HTML, CSS and JS, with no build step and no framework, plus any SVG assets. It will be ported into a Vite, React 19 and Tailwind v4 app, so keep the CSS in custom properties that match the table above and keep the hero animation in one self-contained file.
