# Dependency graph

What requires what.

Choose and state arrow direction, for example dependent → prerequisite. Keep that direction consistent throughout; it differs from data flow. Use levels or clusters to expose prerequisites and shared dependencies. Preserve cycles instead of forcing a DAG layout that hides them; annotate strongly connected groups when useful. Fan-out indicates multiple actual dependencies, not a reason to invent a hub. Use [tree](type-tree.md) only when each non-root truly has one parent.

Geometry examples: [dependency](../assets/example-dependency.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
