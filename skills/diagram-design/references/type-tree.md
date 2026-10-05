# Tree / hierarchy

Single-parent hierarchy and block decomposition.

Every non-root node has exactly one parent; preserve multiple-parent relations with a DAG or cross-links instead of duplicating a node without explanation. Lay out each subtree as a block: parent center is the midpoint of its children's span, child spacing follows subtree width plus gutter. Align depth levels and draw parent/child edges consistently.

For traceable block decomposition, preserve stable hierarchical IDs, parentage, and named input/output contracts. Keep constraints and implementation references attached to the correct block; containment expresses decomposition, while I/O connectors express interfaces. A child ID is a reference key, not merely a display number. Expand the drawing or provide linked detail when the requested interfaces cannot fit.

Geometry examples: [tree](../assets/example-tree.html) · [tree-block-decomposition](../assets/example-tree-block-decomposition.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
