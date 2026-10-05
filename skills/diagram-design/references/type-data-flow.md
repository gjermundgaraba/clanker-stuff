# Data flow

Movement and transformation of payloads.

Use [the process lane geometry](type-process.md) when columns are transformation stages and rows are systems or owners. Edges name the payload or transfer, rather than merely numbering actions. Distinguish control signals from data movement and show stores where persistence matters. A classic data-flow diagram can instead use processes, stores, external entities, and named data edges without stage columns.

Input/output chips may encode formats such as table, JSON, file, or stream; define the codes and direction. A format label does not establish schema compatibility: show meaningful transformations and failures explicitly. Empty lane/stage intersections do not imply missing components. Maintain identifiers linking nodes, steps, lanes, and edges so labels do not become mistaken identities.

Geometry examples: [data-flow](../assets/example-data-flow.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
