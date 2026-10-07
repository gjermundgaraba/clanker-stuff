# Choose a visual grammar

Route by the relationship the reader needs to understand. These are options, not mandatory layouts. Preserve the requested content and notation; scale, panel, or add detail views rather than silently cutting it. Geometry constants in the references are adjustable defaults; data coordinates and semantic relationships remain faithful. Shared styling lives in [design.md](design.md).

| Need                                                              | Reference                                                 | Included variants                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| Two topology snapshots with stable identities and a change ledger | [Architecture delta](type-architecture-delta.md)          | Before · Changes · After                            |
| Floor/site geography and rooms, furniture, or buildings           | [Axonometric plan](type-axonometric-plan.md)              | Office, campus, coffee shop, warehouse              |
| Physical parts separated along one axis                           | [Exploded axonometric](type-exploded.md)                  | Phone, unboxing, AI stack, keyboard                 |
| Row × column combinations and quantitative intensity              | [Heatmap](type-heatmap.md)                                | Complete matrix and declared fill ramp              |
| Runtime components, boundaries, and connections                   | [Architecture](type-architecture.md)                      | —                                                   |
| Compare category magnitudes or paired values                      | [Bar, column, and dumbbell](type-bar.md)                  | Column, horizontal, grouped, stacked, dumbbell      |
| Trends, two-state changes, ranks, and distributions               | [Line and distribution variants](type-line.md)            | Slopegraph, bump, ridgeline, streamgraph            |
| Relations between measures and individual observations            | [Scatter, bubble, and beeswarm](type-scatter.md)          | Bubble, beeswarm                                    |
| Cyclic categories with one nonnegative measure                    | [Polar rays](type-polar.md)                               | —                                                   |
| Comparable multivariate profiles                                  | [Radar / spider](type-radar.md)                           | —                                                   |
| Quantities that split and merge                                   | [Sankey](type-sankey.md)                                  | —                                                   |
| Parts of a whole, optionally hierarchical                         | [Treemap and marimekko](type-treemap.md)                  | Variable-width composition                          |
| A total reconciled through signed contributions                   | [Waterfall](type-waterfall.md)                            | —                                                   |
| Decisions and control flow                                        | [Flowchart](type-flowchart.md)                            | —                                                   |
| Ordered steps and actor handoffs                                  | [Process](type-process.md)                                | —                                                   |
| Movement and transformation of payloads                           | [Data flow](type-data-flow.md)                            | —                                                   |
| Ownership and handoffs through a workflow                         | [Swimlane](type-swimlane.md)                              | —                                                   |
| Messages between participants over time                           | [Sequence](type-sequence.md)                              | OAuth conditional exchange                          |
| States, events, and lifecycle transitions                         | [State machine](type-state.md)                            | Lifecycle phase map                                 |
| Recurring stages and feedback                                     | [Loop / cycle](type-loop.md)                              | —                                                   |
| What requires what                                                | [Dependency graph](type-dependency.md)                    | —                                                   |
| Runtime placement and infrastructure boundaries                   | [Deployment](type-deployment.md)                          | —                                                   |
| Entities and relationship cardinality                             | [ER / data model](type-er.md)                             | —                                                   |
| Physical tables, keys, and referential constraints                | [Database schema](type-db-schema.md)                      | —                                                   |
| Attributes, operations, and object relationships                  | [UML class](type-uml-class.md)                            | —                                                   |
| Reporting and accountability                                      | [Org chart / responsibility map](type-org-chart.md)       | —                                                   |
| Scopes and boundaries                                             | [Nested containment](type-nested.md)                      | —                                                   |
| Ordered abstraction or precedence                                 | [Layer stack](type-layers.md)                             | —                                                   |
| Single-parent hierarchy and block decomposition                   | [Tree / hierarchy](type-tree.md)                          | Traceable block decomposition                       |
| Hierarchy tiers or stage drop-off                                 | [Pyramid / funnel](type-pyramid.md)                       | Conceptual pyramid, measured funnel                 |
| Two dimensions or four categorical scenarios                      | [Quadrant / 2×2 matrix](type-quadrant.md)                 | Quantitative quadrants, categorical scenario matrix |
| Membership and intersections                                      | [Venn / set overlap](type-venn.md)                        | —                                                   |
| Organize candidate causes of a named effect                       | [Fishbone / cause-and-effect](type-fishbone.md)           | —                                                   |
| User needs, value-chain dependencies, and evolution               | [Wardley map](type-wardley.md)                            | —                                                   |
| Work items grouped by current state                               | [Kanban](type-kanban.md)                                  | —                                                   |
| Tasks with dates, duration, and overlap                           | [Gantt](type-gantt.md)                                    | —                                                   |
| Dated events and milestones                                       | [Timeline](type-timeline.md)                              | —                                                   |
| A persona’s experience through stages                             | [User journey](type-journey.md)                           | —                                                   |
| Narrative activities and release scope                            | [User story map](type-story-map.md)                       | —                                                   |
| Existing tools, handoffs, and friction                            | [IT current-state](type-it-state.md)                      | —                                                   |
| Functional phases with a component overview                       | [High-level platform / data lake](type-high-level.md)     | Vertical concerns, unclustered data lake            |
| Sources, platform components, consumers, and shared services      | [Data-platform integration](type-dp-integration.md)       | —                                                   |
| Who can do what on which resource                                 | [Data-platform access matrix](type-dp-security-matrix.md) | —                                                   |
| Data quality tiers and promotion rules                            | [Medallion / data tiers](type-medallion.md)               | —                                                   |

Examples are standalone, offline HTML geometry references with illustrative upstream content and palette. They show concrete arrangements, not production-verified data or mandatory style. Consult the matching type reference when adapting notation or quantitative encodings.
