# Scatter, bubble, beeswarm, and box plot

Relations between measures and individual observations.

Each point represents an observation at its true x/y coordinates on stated scales. Label units, transforms, and population. Crowding is not permission to move points or remove observations. A trend line needs a defined fitted model; it does not establish causation.

## Bubble

Encode a third nonnegative measure by area: `r=K*sqrt(v)` for one `K` throughout; radius proportional to value would square the perceived difference. Explain the size scale and draw larger bubbles first so smaller ones remain visible. Zero has zero area and may need an explicit textual record. Handle missing or negative size values explicitly. Keep centers fixed at their actual x/y values and provide labels or a table for occluded values.

## Beeswarm

One equal-size dot per observation; one axis encodes value and the perpendicular axis only resolves collisions. Keep the value coordinate exact. For circular marks of radius `r` and gap `g`, candidate offsets must satisfy `dx²+dy² >= (2*r+g)²` against previously placed neighbors. Search offsets above/below a category baseline; widen the row when needed. No binning, omitted points, or jitter along the value axis. Explain that swarm thickness is packing density, not a second measured variable.

## Box plot

Compare the shape of 3–8 distributions when a median would hide the spread and individual dots would hide the comparison. Use one horizontal row per group on a shared linear value axis with a stated floor; a truncated axis inflates every box the way it inflates a bar. Below 3 groups a table is shorter, and above 8 split an overview from per-group detail.

Each row draws one five-number summary, and `wlo ≤ q1 ≤ q2 ≤ q3 ≤ whi` must hold. The box spans q1 to q3, so its width encodes the interquartile range and is never padded to fit a label. The median is a 1.5px ink line. Whiskers run to the last inlier inside `q1 − 1.5·IQR` and `q3 + 1.5·IQR`, and outliers are dots strictly beyond them. Compute the summary once, round once, and draw from the rounded numbers. Never move a box along the axis to open up space.

Give the other groups one muted treatment and accent a single group; the median stays ink on every row so it does not compete with the focal fill. Label categories on the left without rotation, and bind each series group with `data-name`, `data-q1`, `data-q2`, `data-q3`, `data-wlo`, and `data-whi` so that the drawing can be checked against the declared values. Bind outliers with `data-x`, because `data-value` on a circle is the beeswarm contract.

Geometry examples: [scatter](../assets/example-scatter.html) · [bubble](../assets/example-bubble.html) · [beeswarm](../assets/example-beeswarm.html) · [box plot](../assets/example-box-plot.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
