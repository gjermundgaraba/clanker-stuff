# Treemap

Parts of a whole, optionally hierarchical.

Allocate rectangle area proportional to nonnegative values: `A_i=A_total*v_i/sum(v)`. Squarified layouts improve comparability over long strips. Nesting expresses actual parent/child membership; parent totals reconcile with descendants. State whether padding is excluded from the encoding.

Do not impose minimum cell areas, log-scale area, or silently remove small categories. Keep exact cells and move small labels to a key; disclosed grouping can help when it preserves the requested scope. Check relative area error `(drawn_area-ideal_area)/ideal_area`, particularly for the smallest cell, if pixel rounding or gutters alter the layout. Display rounding should reconcile with totals or carry a rounding note. An all-zero total has no meaningful partition: show the values in another form.

Geometry examples: [treemap](../assets/example-treemap.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
