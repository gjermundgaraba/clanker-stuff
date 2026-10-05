# UML class

Attributes, operations, and object relationships.

Use compartments for name, attributes, and operations as needed. Member notation includes visibility (`+` public, `-` private, `#` protected), types, and signatures. Interfaces carry `«interface»`; abstract names may be italic.

| Relationship   | Line and end                              |
| -------------- | ----------------------------------------- |
| Generalization | Solid, hollow triangle at superclass      |
| Realization    | Dashed, hollow triangle at interface      |
| Composition    | Solid, filled diamond at whole/owner      |
| Aggregation    | Solid, hollow diamond at whole            |
| Association    | Solid; navigability arrow only when known |
| Dependency     | Dashed, open arrow at dependency          |

Multiplicity belongs at the relevant association end. Composition expresses strong whole/part ownership; do not substitute it for generic references or infer destruction behavior beyond the model. Let compartments grow with relevant members. Omitted members should be clearly scoped, not silently replaced with invented ones.

Geometry examples: [uml-class](../assets/example-uml-class.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
