# Requirement traceability

Which requirements come from a source, are satisfied by a design element, and are verified by a test.

Use one row per requirement in stable source order and four fixed columns: **Source**, **Requirement**, **Satisfied by**, **Verified by**. The headings state each relationship's direction, so no cross-row links are needed. Each cell prints a stable ID and a short name or statement; separate rows with neutral rules. Show an absent relationship as explicit text such as `No verification`, never as an empty box or an invented link. At most one focal row may take the accent, and its text must name the condition.

Use it only when IDs and relationships come from supplied sources, and label an illustrative example. An ID is not evidence that a relationship holds; keep the source reference visible. Use a [dependency graph](type-dependency.md) for package dependencies, a [heatmap](type-heatmap.md) when cells encode values, and [UML class](type-uml-class.md) for type structure. An overview holds about six rows with one primary design and one primary verification link each; put many-to-many traces in a detail view or table.

Rows can carry `data-trace-row` and `data-trace-source`; elements `data-trace-kind` and `data-trace-id`; relationships `data-trace-rel`, `data-trace-from`, and `data-trace-to`, with `data-trace-missing="true"` for an absent link.

Geometry examples: [requirement traceability](../assets/example-requirement-traceability.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
