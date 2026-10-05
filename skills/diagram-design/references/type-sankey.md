# Sankey

Quantities that split and merge.

Node heights and ribbon thicknesses share one `k` pixels per unit: `h=k*q`. Incoming/outgoing quantities reconcile at each node; show sinks, sources, losses, or stock changes explicitly when totals differ. Do not adjust real data to a grid or give tiny flows a fictitious minimum thickness. If grouping is appropriate, name its members and retain the source values.

Allocate a distinct contiguous offset range for every ribbon at each node edge. For source top `(x0,y0)`, target top `(x1,y1)`, thickness `h`, and `m=(x0+x1)/2`, the closed ribbon is:

```svg
M x0,y0 C m,y0 m,y1 x1,y1
L x1,y1+h C m,y1+h m,y0+h x0,y0+h Z
```

Both controls use midpoint x, creating horizontal arrival/departure tangents. Ribbons normally need no arrowhead when stage order states direction. Order nodes and offsets to reduce crossings; reserve label gutters beyond the ribbons. Thickness, rather than ribbon length or area, carries quantity.

Geometry examples: [sankey](../assets/example-sankey.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
