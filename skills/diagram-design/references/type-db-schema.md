# Database schema

Physical tables, keys, and referential constraints.

Table boxes list columns, actual SQL types, nullability, and relevant PK/FK/UNIQUE/index information. Foreign-key edges attach to the specific source and referenced column rows, rather than generic box centers. For header height `h`, row pitch `p`, row `i` has center `table_y+h+(i+0.5)*p`. If several edges attach to one row, fan their ports within that row or add routing gutters without shifting the apparent target.

Composite keys are grouped and mapped together; a single-column arrow must not imply that only one column is constrained. Label referential actions when relevant (`ON DELETE`, `ON UPDATE`) from the actual schema. Do not manufacture cascade behavior or infer uniqueness from a foreign key. Missing schema facts remain unknown.

Geometry examples: [db-schema](../assets/example-db-schema.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
