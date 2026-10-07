---
name: diagram-design
description: Create editorial diagrams or redraw existing diagrams as HTML, SVG, or PNG.
disable-model-invocation: true
license: MIT
metadata:
  upstream-source: "https://github.com/cathrynlavery/diagram-design"
  upstream-path: "skills/diagram-design/"
  upstream-revision: "d1376371965f513d99cc9ec388835d255c5c88d5"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "reconciled"
  upstream-release: "2.6.64"
---

# Diagram Design

Produce a diagram that communicates the requested relationships clearly at its intended display size. Preserve the user's content, audience, format, and styling choices.

Use supplied or established project styling. Otherwise use the editorial defaults in [references/design.md](references/design.md). Apply styling to the output without modifying the installed skill.

Prefer clear hierarchy, restrained emphasis, and independently traceable connections. Simplify presentation without silently removing meaningful content. Choose density and layout for the actual subject and destination; group or split a dense view when that improves comprehension.

Load supporting material for the current task:

- [Design](references/design.md): palette, typography, and a starter template. [Core primitives](references/primitives-core.md) supplies exact SVG markup and port mechanics; [layout and density](references/layout-budget.md) covers budgeting, narrow screens, and print.
- [Types](references/types.md): layout selection and links to type-specific geometry and examples. Read the relevant type reference when adapting its layout.
- [Semantic patterns](references/semantic-patterns.md): queues, policy traces, trust boundaries, and other behavior that ordinary boxes and arrows can obscure.
- [Imports](references/imports.md): existing diagram sources, bundled parsers, and fidelity handling.
- [Export](references/export.md): standalone SVG authoring, PNG rendering, exact sizing, and font handling.
- [Animation](references/animation.md): motion or stepping that helps explain ordered change.

Default to static HTML with inline SVG when no format is specified. For SVG delivery, author a valid self-contained SVG directly from the outset; no HTML intermediary is required. Resolve bundled file and script paths from this skill's directory.

Unless the user specifies a destination, create a workspace with `python3 <skill-dir>/scripts/create_workspace.py <short-topic>` and keep generated files there. The helper prints the new directory's absolute path under `/tmp/diagram-design/YYYY-MM-DD/`. Reuse that workspace for revisions within the same task. Deliver links to the final artifacts. Files under `/tmp` are temporary; use a persistent destination when requested.

Check HTML/SVG structure with `python3 <skill-dir>/scripts/self_check.py <file>`. For PNG delivery, run this check on the HTML/SVG source before rasterization and visually inspect the exported PNG. Inspect the rendered artifact at the intended display size and correct clipping, unreadable labels, and ambiguous connections. Deliver the requested artifact and briefly identify meaningful omissions or verification limitations.
