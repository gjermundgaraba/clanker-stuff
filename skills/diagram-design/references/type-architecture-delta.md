# Architecture delta

**Best for:** explaining a system migration, service extraction, infrastructure redesign, or integration change through two synchronized topology snapshots. Show which components and relationships survive, appear, disappear, change their properties, move, or reconnect.

**Not this type:**

- One system snapshot → **Architecture** (`type-architecture.md`).
- Attribute-only differences without a topology story → a **comparison table**. Two versions of a configuration do not need two node maps.
- Requests over time → **Sequence** (`type-sequence.md`); deployment phases → **Timeline** (`type-timeline.md`). A delta has exactly two states and does not establish migration order, downtime, or causality.
- Host/container placement in one environment → **Deployment** (`type-deployment.md`).

## Layout conventions

Geometry and density values below are starting points, not permission to omit requested content. Adapt styling via [design.md](design.md).

- **Three panels, one reading order: Before · Changes · After.** Use comparable dimensions, scale, and coordinate frames for both topology panels. The center panel is a short change ledger, not a third topology. Name the snapshots with meaningful versions or dates.
- **Keep the mental map stable.** Start by copying the Before coordinates into After. Avoid independently arranging each snapshot: arbitrary drift looks like system movement. If extra label space is needed, adjust both layouts together where practical.
- **Panel positions are not component positions.** Local coordinates in translated SVG groups are a convenient way to keep the snapshots comparable; other standard SVG grouping, transforms, and drawing features are also usable.
- **Alignment:** a shared 4px grid is a useful starting preference for node bounds and panel rules, not an exact numerical contract. Prioritize readable labels, clear ports, and comparable layouts.
- **Density:** around **8 unique components**, **10 unique relationships**, and **8 ledger entries** is a readable starting range for one comparison. A retained ID counts once, not once per snapshot. For denser migrations, expand the canvas or use named subsystem comparisons with explicit cross-boundary relationships. Never drop facts or edges to meet a budget.
- **Connectors:** use Architecture's rounded orthogonal routing and port guidance. Draw connectors before components. A stable relationship may reroute to reach a moved component without becoming `REWIRED`. Use standard SVG paths, lines, arcs, or other drawing features as needed; there is no type-specific path-command grammar.
- **Nodes:** print the same stable ID in both states along with the human-readable name. Names, responsibilities, implementation versions, and protocols can be semantic attributes; identities survive a rename when the underlying object survives. Preserve distinct relationship identities and parallel relationships, not just node pairs.
- **Ledger:** briefly name each changed object and its actual difference, using the vocabulary below. Group related entries when that reads better, but keep every addition, removal, semantic change, represented relocation, and rewire traceable. Do not list unchanged objects or cosmetic adjustments as changes.
- **Responsive presentation:** preserve the comparison on small screens with an accessible horizontal scroll region and a visible scroll hint. Do not compress labels until illegible or stack snapshots into independently scaled pictures. Print and export keep the whole comparison.

## Change vocabulary and redundant encoding

Color is secondary. Every change is readable from text plus a shape or line treatment; unchanged objects remain quiet context. Use the existing skin tokens and reserve the accent for the editorial focus, rather than assigning five status colors.

| State                   | Meaning                                                                         | Non-color treatment                                                                |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `unchanged`             | Same represented identity, semantics, and endpoints; no relocation in the story | Plain solid outline; no ledger entry                                               |
| `added` / **ADDED**     | Present only in After                                                           | `+` badge or plus-shaped marker; solid outline                                     |
| `removed` / **REMOVED** | Present only in Before                                                          | `−` badge and dashed outline/path                                                  |
| `changed` / **CHANGED** | Retained object whose represented semantic attributes differ                    | `Δ` badge or inset rule, plus an explicit old → new ledger description             |
| `moved` / **MOVED**     | Retained component whose represented placement changes                          | Direction/position marker and a ledger entry naming the relocation                 |
| `rewired` / **REWIRED** | Retained relationship whose ordered source/target identities differ             | Distinct dash treatment or endpoint marker, with old → new endpoints in the ledger |

A component can be changed and moved; a relationship can be changed and rewired. Explain both differences without conflating them.

Do not use a missing After node to stand for a removal without explaining `REMOVED`. Do not substitute an `ADDED` edge for a `REWIRED` edge just to avoid explaining endpoint identity. A replacement component gets a new stable ID and separate removal/addition accounting; its location alone cannot establish continuity.

**Presentation is not semantics.** Width, height, text wrapping, styles, panel offsets, and connector routing do not by themselves justify `CHANGED`. Reserve `MOVED` for a relocation the comparison actually represents, such as a worker moving into another boundary. Pure drawing reflow is not a system relocation; keep the layouts comparable and disclose any necessary presentation-only shift rather than inventing a migration event.

## Identity and meaningful change accounting

Use the source facts to compare the two snapshots:

- An identity present only in Before is removed; one present only in After is added. Do not recycle IDs across unrelated objects or between components and relationships.
- A retained component keeps its identity through semantic edits or relocation. A retained relationship keeps its identity through protocol changes, rerouting, or endpoint changes when it remains the same represented relationship.
- Compare represented attributes directly. For a `CHANGED` object, state the actual old → new attribute values; for a `REWIRED` relationship, state old → new ordered endpoints. Verify each endpoint exists in its snapshot and that arrows meet the intended node, not just a nearby box.
- Match the ledger to the actual differences in both snapshots. Every meaningful difference needs an explanation; every ledger claim needs corresponding evidence. Keep parallel edges, multiplicity, and boundary membership faithful to the source.

HTML `data-*` metadata can help author or review a diagram, but is optional. There is no required public metadata DSL, status-token schema, bounds proxy, or duplicate machine-readable ledger. The shipped example's stable IDs and endpoint attributes are useful local authoring aids, not a runtime interface.

If semantic signatures are useful, derive them only from the represented attributes under comparison, such as `orders-api:v2;mode=enqueue` or `protocol=https;operation=create-order`. Exclude IDs, snapshot names, statuses, geometry, text wrapping, styles, and endpoints: these are not semantic attribute edits. A name belongs in the signature only when renaming is part of the story. A signature is optional comparison shorthand, not a hash to regenerate on every redraw or a substitute for a readable explanation.

## Verification and its boundaries

Check accessible SVG structure and local references with `python3 <skill-dir>/scripts/self_check.py <file>`. The bundled structural checker does **not** establish topology fidelity, identity continuity, change classification, or ledger accuracy.

Manually compare source facts, both snapshots, and the ledger: retained identities, all components and relationships (including parallel ones), old/new attributes, represented placement, endpoint order, and complete meaningful change accounting. Do not mistake a cleaner layout for a changed system.

Inspect both snapshots at the destination size and without relying on color. Review labels, clipping, occlusion, connector crossings, segment clearance, arrow attachment, and ledger placement. Preserve the standard accessible SVG title/description contract and readable narrow-screen and print presentation.

## Anti-patterns

- Two independently arranged snapshots that manufacture apparent movement.
- A center ledger that says only “updated” without naming the object and difference.
- Calling a wider box or wrapped label `CHANGED`, or recording drawing reflow as a system relocation.
- Color-only statuses or a separate bright color for every kind of change.
- Semantic edits hidden behind “unchanged,” or all signatures regenerated just because the snapshot changed.
- Redrawing an edge to a different component while claiming its endpoints are unchanged.
- Merging parallel relationships or counting retained objects twice to justify dropping other objects.
- Treating this comparison as an executable migration plan. Ordering, rollback, availability, and data consistency need their own explanation.

## Examples

- `assets/example-architecture-delta.html` — minimal light order-fulfilment migration; additions, removals, semantic change, and rewiring.

The example retains the storefront, fulfilment worker, and order store, changes the order API to enqueue work, removes the legacy dispatcher, adds a durable order queue, and rewires order submission. The worker's drawing position shifts only for layout, explicitly disclosed as a presentation note rather than a `MOVED` event. Its stable database relationship reroutes while preserving its ID and endpoint semantics.
