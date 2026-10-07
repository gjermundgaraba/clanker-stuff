# Treemap

Parts of a whole, optionally hierarchical.

Allocate rectangle area proportional to nonnegative values: `A_i=A_total*v_i/sum(v)`. Squarified layouts improve comparability over long strips. Nesting expresses actual parent/child membership; parent totals reconcile with descendants. State whether padding is excluded from the encoding.

Do not impose minimum cell areas, log-scale area, or silently remove small categories. Keep exact cells and move small labels to a key; disclosed grouping can help when it preserves the requested scope. Check relative area error `(drawn_area-ideal_area)/ideal_area`, particularly for the smallest cell, if pixel rounding or gutters alter the layout. Display rounding should reconcile with totals or carry a rounding note. An all-zero total has no meaningful partition: show the values in another form.

## Marimekko

Use variable-width stacked columns when both category volume and within-category composition matter. Equal-width 100% stacked bars discard category size; a treemap may better express nested parts without a two-axis composition story.

For category total `C_j=sum_i(v_ij)` and grand total `T=sum_j(C_j)`, allocate available plot width `W` (after constant inter-column gutters) as `w_j=W*C_j/T`. All columns share one height `H`; segment height is `h_ij=H*v_ij/C_j`. Thus segment area is proportional to its share of the grand total. Keep no vertical gutters between segments, one fixed series order across columns, and the same stated plot origin, dimensions, and gutter for the complete figure.

Use nonnegative values and disclose display rounding. A zero category has no proportional width, and an absent series has no positive segment; report it in the source data/legend rather than adding a minimum-size rectangle. An all-zero total has no meaningful partition. Do not widen a column or pad a segment to make a label fit.

The example uses up to 8 categories and 5 series, an ink tonal ramp with one focal segment, inside labels only where they fit, and outside labels or a legend for small segments. Marker/leader labels must not alter data geometry. “Other” is appropriate only when the grouping is named, preserves the requested scope, and is disclosed.

### Data bindings and checks

Each segment rect declares `data-column`, `data-segment`, and `data-amount`. Segment labels use the same identities with `data-role="label"`; column captions use `data-column` and `data-role="caption"`; legend keys use `data-segment` and `data-role="key"`.

Check width, height, and area shares against the amounts; equal column heights, a constant gutter, complete tiling, fixed series order, label bindings, and printed amounts/shares against totals. Keep geometry explicit in attributes rather than CSS transforms when comparing it to data. The bundled structural checker does not establish these quantitative contracts.

State the unit, period, total, and whether the values are illustrative. Never silently drop a category or series, switch series order per column, or let a printed total contradict the segments beyond explained rounding.

Geometry examples: [treemap](../assets/example-treemap.html) · [marimekko](../assets/example-marimekko.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
