# Waterfall

A total reconciled through signed contributions.

Preserve the ordered running total: `R_i=R_(i-1)+delta_i`. End and subtotal values equal the corresponding running sum; subtotals are observations of that sum, not extra contributions. All bars share units and a zero-inclusive scale. Totals span zero to their value; a delta spans the prior and new running levels.

With `y(v)=T+H-H*(v-a)/(b-a)`, a bridge has `top=min(y(R_prev),y(R_next))` and `height=abs(y(R_next)-y(R_prev))`. Carry connectors cross the gap at `y(R_next)`. Sign is explicit in labels and distinguishable without color alone. Negative totals are valid with the appropriate domain. A zero delta can retain its position with a zero label/hairline; do not silently remove its category. Never enlarge small bridges for visibility. Use a finite fallback domain for all-zero data.

Geometry examples: [waterfall](../assets/example-waterfall.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
