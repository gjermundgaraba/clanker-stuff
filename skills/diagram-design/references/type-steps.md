# Steps

A short ordered method where the order is the claim.

Use one left-to-right rail of 3–7 equal stages, each with a two-digit number, an optional icon in a circular medallion, a title, and at most two short description lines. Prefer [timeline](type-timeline.md) when spacing encodes elapsed time, [flowchart](type-flowchart.md) when the route branches, [swimlane](type-swimlane.md) when ownership and handoffs matter, and [process](type-process.md) when each stage must expose actors or payloads. Steps has no branches, time scale, or actor lanes.

The rail is one contiguous band of equal segments with alternating quiet ink tints; it already says "next", so add no arrows between stages. Paint an opaque paper circle under each medallion outline so the rail does not show through. Use one coherent icon set or no icons, never a mix. Mark exactly one focal stage, and give its number, guide, segment, medallion, and title the accent as one unit; every other stage stays neutral. Do not color each stage differently, because hue would then read as category rather than order. Rewrite long copy or widen the canvas instead of shrinking type. Say in a legend or note that equal spacing shows order, not elapsed time.

The example uses `0 0 1280 720` with 224-unit stages for 3–5 steps (184 for 6, 160 for 7), centered, with a 48-unit rail at `y=240` and 36-unit medallions.

Geometry examples: [steps](../assets/example-steps.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
