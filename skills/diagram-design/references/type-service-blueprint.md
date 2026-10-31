# Service blueprint

What the customer sees versus hidden service work across stages.

Stages are equal columns in narrative order and layers are labeled rows on one shared grid. The line of visibility carries the meaning: customer and frontstage actions sit above it, backstage and support sit below it. Use a blueprint when the reader must see that a visible retry is really a billing job, a queue, or a fraud check. The grid is a census, not a flow: stage order is the sequence, and waits and system names are cell text. Connector arrows would make it a [swimlane](type-swimlane.md), a sentiment curve a [user journey](type-journey.md), and data payloads between steps a [process](type-process.md).

Layers from top to bottom are physical evidence (optional), customer actions, line of interaction, frontstage actions, line of visibility, backstage actions, line of internal interaction, and support processes (optional). Customer, frontstage, and backstage are required, and each stage needs a cell in all three; mark an empty cell with `—` or `Not applicable` rather than omitting it. A cell holds one action in one line, plus at most one muted line for a system or wait such as `dunning-job · 4h`.

The example uses `0 0 1280 720`, a 96-unit left margin with horizontal end-anchored layer labels, 4–6 stage columns of 208 units with 16-unit gutters, and 64-unit required layers. Interaction lines are 1-unit rules. The visibility line is 2 units of ink at 0.55 opacity, which measures 3.19:1 on the default paper; 0.45 falls below 3:1. It must span the plot and sit between frontstage and backstage. Keep upper layers on paper and tint the layers below the line so they read as hidden work. Accent at most one focal cell, usually the failure, wait, or handoff on or below the line, and name it in the legend.

Each layer group declares `data-layer` as `evidence`, `customer`, `frontstage`, `backstage`, or `support`. Each cell declares a `data-stage` matching its column header and a `data-name` matching its printed action, an optional focal cell adds `data-focal="true"`, and the lines use `data-role` of `interaction`, `visibility`, and `internal-interaction`.

Geometry examples: [service blueprint](../assets/example-service-blueprint.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
