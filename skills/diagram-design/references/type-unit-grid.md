# Unit grid

One bounded whole counted in equal discrete units out of 100.

Draw a 10 × 10 waffle of exactly 100 equal cells, each one unit, filled in reading order from the top left. Completed cells share one ink fill, remaining cells one quieter fill, and at most one completed cell takes the accent as editorial emphasis, not a special unit. Rows and columns carry no category. Print the exact count next to the grid (for example `64%` and `64 complete · 36 remaining`), state the unit in the source line, and keep the figure readable in grayscale.

Each mark equals one unit. Never use partial, merged, larger, or differently shaped cells, gradients, or area to recover precision; if a value is rounded to whole cells, say so. A denominator that is not naturally 100 needs whole cells that keep the unit honest, or another chart. Use a [bar chart](type-bar.md) to compare categories and a [treemap](type-treemap.md) for unequal parts of a whole.

The example uses `0 0 1000 390` with 20-unit cells, 4-unit gutters, and the grid at `(382, 86)`. Bake positions into cell coordinates rather than transforming the grid, and bind cells with `data-unit-cell` and a unique `data-unit-index` when the figure should be checkable.

Geometry examples: [unit grid](../assets/example-unit-grid.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
