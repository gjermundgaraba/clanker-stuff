# Architecture

Runtime components, boundaries, and connections.

Group nodes by actual deployment, ownership, or trust boundaries; label what each boundary means. Edges represent a stated relationship such as request, data transfer, or dependency. Do not infer that relationship from proximity. Keep edge direction and solid/dashed meanings consistent and explain them when ambiguous.

Route from node ports through clear corridors. For a right-to-down turn at `(m,y1)` with radius `r`, use `H m-r Q m,y1 m,y1+r V y2`; clamp `r` to the available segment lengths. Fan several endpoints along an edge instead of stacking arrowheads. At an unavoidable crossing, bridge one edge or leave a visible gap so it cannot be read as a junction. Draw connectors before opaque nodes. Zone bounds include the nodes and header clearance.

Choose ports on the straight part of a node edge, away from rounded corners, and leave/enter perpendicular to that edge. If a destination is above or below, a single-bend path can leave the source's facing side edge, turn once, and enter the destination's bottom/top. Do not start a horizontal segment on a top/bottom border; it rides behind the fill and reads as a corner port. Fan multiple side ports and keep their routes distinct; see [core primitives](primitives-core.md).

Label zones in soft rather than ink at an opacity; a translucent eyebrow composites differently on every paper and can fall well below 4.5:1. Keep flat sibling zones to about 3, or use a [swimlane](type-swimlane.md).

## Containment

Use containment when the network hierarchy itself carries the meaning, so a flattened label such as `VNET · SNET-APP` would misstate it. Connectors follow this reference; insets and per-level labels follow [nested containment](type-nested.md). Distinguish two scope kinds by shape, not color alone, so greyscale still separates them: an administrative scope (billing, permissions, lifecycle; it holds no traffic) is a full-width band with a header, and a traffic scope (a boundary packets cross only by explicit rule) is a rounded box.

A managed service never sits inside a traffic scope. It belongs to the administrative band that owns it, and only its private endpoint sits in the subnet. Drawing a database inside a subnet implies it sits behind that subnet's security rules, which it does not.

Sibling traffic scopes share one axis: a row under a wide parent, a column under a tall one, and the perpendicular axis at the next level down. Draw each scope in place with its own `x`, `y`, `width`, and `height`, because containment is read from those bounds. Start from about 2 administrative bands, 4 traffic scopes, 8 nodes, and 2 accent elements, and split per subscription or account beyond that.

Geometry examples: [architecture](../assets/example-architecture.html) · [containment](../assets/example-architecture-containment.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
