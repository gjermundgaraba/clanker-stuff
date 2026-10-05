# Scatter, bubble, and beeswarm

Relations between measures and individual observations.

Each point represents an observation at its true x/y coordinates on stated scales. Label units, transforms, and population. Crowding is not permission to move points or remove observations. A trend line needs a defined fitted model; it does not establish causation.

## Bubble

Encode a third nonnegative measure by area: `r=K*sqrt(v)` for one `K` throughout; radius proportional to value would square the perceived difference. Explain the size scale and draw larger bubbles first so smaller ones remain visible. Zero has zero area and may need an explicit textual record. Handle missing or negative size values explicitly. Keep centers fixed at their actual x/y values and provide labels or a table for occluded values.

## Beeswarm

One equal-size dot per observation; one axis encodes value and the perpendicular axis only resolves collisions. Keep the value coordinate exact. For circular marks of radius `r` and gap `g`, candidate offsets must satisfy `dx²+dy² >= (2*r+g)²` against previously placed neighbors. Search offsets above/below a category baseline; widen the row when needed. No binning, omitted points, or jitter along the value axis. Explain that swarm thickness is packing density, not a second measured variable.

Geometry examples: [scatter](../assets/example-scatter.html) · [bubble](../assets/example-bubble.html) · [beeswarm](../assets/example-beeswarm.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
