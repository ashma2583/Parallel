# PARALLEL landing page

Plain HTML, CSS and JS. No build step.

- `index.html`: the page. Theme toggle and section reveal are the inline script at the bottom.
- `styles.css`: all page styles. Colour tokens are custom properties on `:root`; light mode via `prefers-color-scheme` or `data-theme="light"` on `<html>`. Map these onto Tailwind v4 `@theme` when porting.
- `hero.js`: the hero animation, self-contained. Inlines `campus-graph.json`, runs the constraint model (feed supply is a hard cap, policies decide shed order), draws the SVG and loops. Also draws the four static step diagrams. Reads the page tokens `--powered --reduced --dark --line --accent --hair --panel --text --muted`.
- `campus-graph.json`: source data, unchanged.

Hero numbers are computed live by the model for the heat wave scenario (central at 35%, north at 50%). The comparison table uses figures from a real run in the app (fork at tick 7, 6 ticks).

Placeholders to fill: `[CONTACT EMAIL]`, `[REPOSITORY URL]` in the footer. The primary action links to `/app`.

Reduced motion: the hero renders the branched end state as a still frame; section reveals are off.
