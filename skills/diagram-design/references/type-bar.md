# Bar, column, and dumbbell

Compare category magnitudes or paired values.

Bar length encodes value: use a shared scale anchored at zero, including negative values on the opposite side. Horizontal bars accommodate long labels. Grouped bars compare series within categories; stacked bars encode additive parts and totals. A 100% stack compares composition and needs denominators when group sizes matter.

For plot bounds `(L,T,W,H)`, `x(v)=L+W*(v-a)/(b-a)` and `y(v)=T+H-H*(v-a)/(b-a)`. Bar height is `abs(y(v)-y(0))`; its top is `min(y(v),y(0))`. Use a finite span when all values coincide; for all-zero magnitude data, `[0,1]` in the stated unit is a useful fallback. Do not snap data coordinates to a layout grid.

## Dumbbell

One category per row, exactly two comparable values on one horizontal scale, connected by a line. The line encodes their gap, not a measured trajectory. Distinguish the endpoints by shape or hollow/filled marks and label the series. Use a zero-inclusive domain by default to avoid overstating gaps; disclose any justified zoom. State row order (for example, signed change or absolute change).

Place value labels outside `min(x1,x2)` and `max(x1,x2)` regardless of which series increased; near the plot boundary, put the label above its point. Overlapping points keep their true coordinates: use smaller markers or explicit coincident-value labels. Missing endpoints remain identified as missing, never fabricated or silently omitted.

Geometry examples: [bar](../assets/example-bar.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
