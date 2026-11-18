# Dependency graph

What requires what.

Choose and state arrow direction, for example dependent → prerequisite. Keep that direction consistent throughout; it differs from data flow. Use levels or clusters to expose prerequisites and shared dependencies. Preserve cycles instead of forcing a DAG layout that hides them; annotate strongly connected groups when useful. Fan-out indicates multiple actual dependencies, not a reason to invent a hub. Use [tree](type-tree.md) only when each non-root truly has one parent.

## Arc diagram

When skip-layer imports among 4–9 packages are the story, place the packages as equally spaced dots on one baseline and draw each import as a rising semicircle, `M x1,y A r,r 0 0 1 x2,y` with `r` half the endpoint distance, so arc height is proportional to the number of seats skipped. Uneven spacing breaks that encoding. Order the rail by import direction so every ordinary arc runs left to right, and say so in the caption. Give the remaining arcs one muted stroke and accent the single import that matters, adding an arrowhead only to that arc when it runs against the rail. Paint longer arcs first and the focal arc last. Never fill an arc. An arc diagram has no ranks or cycle routing; use the ranked layout for those. Arcs can carry `data-from`, `data-to`, and `data-span` (the seat distance).

Geometry examples: [dependency](../assets/example-dependency.html) · [arc diagram](../assets/example-arc-diagram.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
