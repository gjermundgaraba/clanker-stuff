# Architecture

Runtime components, boundaries, and connections.

Group nodes by actual deployment, ownership, or trust boundaries; label what each boundary means. Edges represent a stated relationship such as request, data transfer, or dependency. Do not infer that relationship from proximity. Keep edge direction and solid/dashed meanings consistent and explain them when ambiguous.

Route from node ports through clear corridors. For a right-to-down turn at `(m,y1)` with radius `r`, use `H m-r Q m,y1 m,y1+r V y2`; clamp `r` to the available segment lengths. Fan several endpoints along an edge instead of stacking arrowheads. At an unavoidable crossing, bridge one edge or leave a visible gap so it cannot be read as a junction. Draw connectors before opaque nodes. Zone bounds include the nodes and header clearance.

Choose ports on the straight part of a node edge, away from rounded corners, and leave/enter perpendicular to that edge. If a destination is above or below, a single-bend path can leave the source's facing side edge, turn once, and enter the destination's bottom/top. Do not start a horizontal segment on a top/bottom border; it rides behind the fill and reads as a corner port. Fan multiple side ports and keep their routes distinct; see [core primitives](primitives-core.md).

Geometry examples: [architecture](../assets/example-architecture.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
