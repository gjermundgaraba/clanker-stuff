# High-level platform / data lake

Functional phases with a component overview.

A phase banner maps components to source, ingest, storage, query, or consumption responsibilities. Center components under the phase they implement; shared components can span phases with an explicit label. Boundaries identify actual clusters or platforms. An unclustered data-lake variant omits an orchestration boundary when it does not exist.

For phase widths `w_i`, compute `boundary_i=L+sum(w_0…w_(i-1))` and `center_i=boundary_i+w_i/2`; distribute nodes around those centers as content requires. With node height `h` and gap `g`, stacked node tops are `top+k*(h+g)`. A vertical concern strip is optional: reserve its width before allocating phase columns, and map each concern label explicitly to its spanning bar. The strip labels are not runtime components and do not emit edges.

Separate orchestration triggers, queries, and payload movement by labeled edge semantics. Do not manufacture a hub or suppress connections to satisfy a fan-out quota. Shared identity/observability bars indicate scope only as supported by the actual system.

Geometry examples: [high-level](../assets/example-high-level.html) · [high-level-vertical](../assets/example-high-level-vertical.html) · [datalake](../assets/example-datalake.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
