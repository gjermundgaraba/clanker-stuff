# Line and distribution variants

Trends, two-state changes, ranks, and distributions.

Use a shared numeric y-scale and chronological or ordered x-scale. Unequal time intervals have unequal horizontal distances. Straight segments connect observations; missing observations produce a gap unless interpolation is explicitly part of the model. Show units and domain. Zero is useful for magnitude comparisons but a clearly labeled nonzero domain can reveal variation. Area fills imply a baseline and need particular care with truncated axes.

## Slopegraph

Exactly two comparable states, with names and values at both ends. Both axes share scale, origin, direction, and units. State a nonzero domain when used. Crossings show endpoint order reversal; they do not identify when a crossover happened. Move labels with leaders to solve crowding, never move data endpoints. Identify coincident series and incomplete pairs explicitly.

## Streamgraph

Use a symmetric stacked area for a total and its changing composition across periods. It reveals volume and shares together, not exact values or rank. For one series use a normal area/line, for two snapshots a slopegraph, for precise per-period comparisons a bar chart or table.

For each period `j`, sum nonnegative layer values `T_j=sum_i(v_ij)`. With constant centerline `c` and one shared scale `s`, the envelope is `c ± s*T_j/2`; each layer's thickness is `s*v_ij`. Stack layers in one fixed order across all periods, typically placing the largest totals toward the center. Never use independent layer scales or reorder layers to smooth the picture.

The example uses evenly spaced weekly buckets, 3–24 periods and 2–6 layers as a readable starting range, paper hairlines between layers, a tonal ink ramp plus one accent layer, and a legend with each layer's sum and units. A continuous-time domain with uneven observation times must instead preserve actual time distances or disclose resampling. State bucket size, shared scale, and the symmetric (zero-sum) baseline. No y ticks are needed for a shape-focused view; include a table when precision matters.

Zero periods remain in the domain: a band pinches to zero thickness and reopens. Keep a complete legend with totals derived from the observations. Skin-neutral legend wording such as “strongest tone” works on light and dark paper.

Use shared piecewise-linear boundaries by default: compute the cumulative stack once at each period and connect those boundary vertices with straight segments. Adjacent layers reuse exactly the same boundary. Between nonnegative observations, each thickness is then a linear interpolation of nonnegative values; a layer that is zero in two consecutive periods stays zero throughout that interval.

Smooth boundaries only when interpolation is justified by the data and verified throughout each interval, not merely at the observations. Reuse each shared boundary for both adjacent layers, retain true stacked vertices, and disclose smoothing. Check nonnegative thickness, zero intervals, contiguous tiling, and the centered envelope between samples. Independent cubic smoothing can cross boundaries and invent negative quantities even when all sampled values are correct.

### Quantitative checks

The example keeps optional authoring data on layer paths (`data-layer`, `data-values`), period captions (`data-period`, `data-index`), and legend labels (`data-layer`, `data-total`). These help trace the drawing back to its values; they are not a required chart metadata contract.

Compare every boundary vertex with its period column and cumulative value. Verify layer thickness on one shared scale, identical shared boundaries, a centered envelope, zero intervals, and printed totals against the source sums. For the example's straight segments, nonnegative endpoint thicknesses establish nonnegative thickness throughout each interval. Other interpolation needs additional between-sample verification. The generic structural checker checks accessible structure and references, **not** quantitative geometry or data fidelity.

Do not silently drop small layers, bridge zeros, switch bucket size, place unreadable text on fills, or present a bottom-pinned stacked area as a symmetric streamgraph. Series names remain the user's exact labels; a name containing digits is not an excuse to rename it.

## Bump chart

Rank across ordered snapshots: `y(rank)=top+pitch*(rank-1)`, with rank 1 at the top. State the ranking measure and tie policy; keep that definition consistent across snapshots. Rank distance does not encode the difference in underlying values. Show ties faithfully and break lines at absence, entry, or exit. Connections between snapshots are not measured trajectories.

## Ridgeline

Stack distributions on a shared x-scale with row baselines `b_i=top+i*pitch`. For normalized bin shares `p_ij=count_ij/sum(count_i)`, use `y_ij=b_i-A*p_ij` with one amplitude `A` across rows. This encodes concentration, not sample volume; show sample counts if volume matters. Alternatively use counts or density and state that choice. Keep binning or density estimation comparable and name smoothing/bandwidth when used.

Close shapes along their own baselines. Do not invent zero endpoint bins where the observed distribution is clipped; disclose clipping or extend the domain with justified data. Increase pitch or the canvas if overlap hides peaks, rather than changing one row's amplitude.

Geometry examples: [line](../assets/example-line.html) · [slopegraph](../assets/example-slopegraph.html) · [ridgeline](../assets/example-ridgeline.html) · [bump](../assets/example-bump.html) · [streamgraph](../assets/example-streamgraph.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
