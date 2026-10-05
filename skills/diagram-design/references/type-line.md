# Line and distribution variants

Trends, two-state changes, ranks, and distributions.

Use a shared numeric y-scale and chronological or ordered x-scale. Unequal time intervals have unequal horizontal distances. Straight segments connect observations; missing observations produce a gap unless interpolation is explicitly part of the model. Show units and domain. Zero is useful for magnitude comparisons but a clearly labeled nonzero domain can reveal variation. Area fills imply a baseline and need particular care with truncated axes.

## Slopegraph

Exactly two comparable states, with names and values at both ends. Both axes share scale, origin, direction, and units. State a nonzero domain when used. Crossings show endpoint order reversal; they do not identify when a crossover happened. Move labels with leaders to solve crowding, never move data endpoints. Identify coincident series and incomplete pairs explicitly.

## Bump chart

Rank across ordered snapshots: `y(rank)=top+pitch*(rank-1)`, with rank 1 at the top. State the ranking measure and tie policy; keep that definition consistent across snapshots. Rank distance does not encode the difference in underlying values. Show ties faithfully and break lines at absence, entry, or exit. Connections between snapshots are not measured trajectories.

## Ridgeline

Stack distributions on a shared x-scale with row baselines `b_i=top+i*pitch`. For normalized bin shares `p_ij=count_ij/sum(count_i)`, use `y_ij=b_i-A*p_ij` with one amplitude `A` across rows. This encodes concentration, not sample volume; show sample counts if volume matters. Alternatively use counts or density and state that choice. Keep binning or density estimation comparable and name smoothing/bandwidth when used.

Close shapes along their own baselines. Do not invent zero endpoint bins where the observed distribution is clipped; disclose clipping or extend the domain with justified data. Increase pitch or the canvas if overlap hides peaks, rather than changing one row's amplitude.

Geometry examples: [line](../assets/example-line.html) · [slopegraph](../assets/example-slopegraph.html) · [ridgeline](../assets/example-ridgeline.html) · [bump](../assets/example-bump.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
