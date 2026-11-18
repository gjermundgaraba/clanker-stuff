# SBGN process description

A biological process as a bipartite species/process graph.

Every reaction is a process square and every molecule a macromolecule (rounded rectangle). Arcs connect a species to a process or a process to a species, never two of the same kind, and each declares its role: consumption and production take a filled arrow, a reversible pair is two-headed, and modulation takes an open-circle head. Draw the enclosing compartment as a labeled zone before arcs and nodes; an empty-set circle with a diagonal marks a source or sink. Keep SBGN's shape semantics and the house monochrome palette rather than color-coding roles, so greyscale still distinguishes them, and accent at most two elements: the focal species and its process.

Lay substrates, processes, and products left to right with orthogonal rounded connectors, give a shared product its own trunk, and bridge an unavoidable crossing. Arcs never stack or end on one another. Use [architecture](type-architecture.md) for runtime systems, [nested](type-nested.md) for containment without reactions, and [Sankey](type-sankey.md) for conserved quantities. Author from the supplied model; this skill does not import SBML or SBGN-ML.

The example holds 7 macromolecules, 6 processes, 1 compartment, and 16 arcs. Because a process square is a reaction marker rather than a node and every reaction needs its arcs, that ceiling replaces the usual node and edge planning for this grammar only; split a larger map into an overview and a reaction family. Glyphs can carry `data-kind` and stable IDs, and arcs `data-kind`, `data-from`, and `data-to`.

Geometry examples: [SBGN](../assets/example-sbgn.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
