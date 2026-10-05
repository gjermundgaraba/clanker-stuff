# Data-platform integration

Sources, platform components, consumers, and shared services.

Sources sit outside one side of a platform boundary and consumers outside the other; platform rows express functional grouping. Label traffic with relevant protocol, data, or trigger semantics. Cross-cutting services can connect to the platform boundary when they apply platform-wide; connect to individual components when integration is specific. A full-width bar alone does not prove universal coverage.

For side node height `h=64` and gap `g=24`, row `k` starts at `top+k*(h+g)`. Side extent is `max(n_sources,n_consumers)*(h+g)-g` for a nonempty set. Platform height must also fit its own rows. For inner width `W`, padding `p`, gap `g`, and `N>0` equal nodes, `node_w=(W-2*p-(N-1)*g)/N`. Grow dimensions for text instead of shrinking it indefinitely. Footer concerns add their actual bar heights and gaps below the platform; include the resulting extent in the canvas.

Geometry examples: [dp-integration](../assets/example-dp-integration.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
