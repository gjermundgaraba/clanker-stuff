# ER / data model

Entities and relationship cardinality.

Use entity boxes and relationship edges with cardinality at both ends, such as `1`, `0..1`, `0..*`, or `1..*`. Keep optionality separate from maximum multiplicity and use one notation consistently. Label relationships when endpoint names do not explain them. Fields may be listed, but edges attach to entities at this conceptual level. Do not infer cardinality merely from example records. Use [database schema](type-db-schema.md) for column-level foreign keys and SQL constraints.

Geometry examples: [er](../assets/example-er.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
