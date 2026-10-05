---
name: pr-lens
description: Draw local animated architecture or data-flow diagrams when the user explicitly requests PR Lens for a codebase or change.
disable-model-invocation: true
---

# PR Lens

PR Lens draws code as visually rich animated diagrams. It can represent diffs, architecture, data flows, and more.

Represent the diff or code as one JSON document of lanes, nodes, edges, and optional ordered flows, then render it as animated SVGs.

## Local-only boundary

Keep the entire workflow on the local filesystem. Do not create, edit, or comment on pull requests; do not run `gh`; do not upload or publish diagrams; do not push or commit files; and do not send the diff to a hosted analysis provider. Stop after rendering and showing the local output.

## Operating manual

1. **Read the diff.** When asked to represent a code change: `git diff --find-renames <base>...<head>`. The base is the merge base, not the tip of the base branch.

   For architecture or data-flow diagrams without a diff, read the code in the requested scope.

2. **Write the document** to `.pr-lens/graph.json`. For a first graph, start from [starter.graph.json](references/starter.graph.json): one lane, a changed node, an unchanged neighbour, and one hero edge. Replace its fictional repository, commits, file paths, metrics, and behavior with evidence from the requested scope.

   Consult only the relevant sections of [the document reference](references/graph-document.md) for fields, limits, and relationships. Use [the full example](references/example.graph.json) when adding flows or nested views. Neither full reference is required reading for a simple graph.

3. **Validate, and fix**

   ```bash
   npx @coldtea/pr-lens-cli validate .pr-lens/graph.json
   ```

   Correct validation failures in the authored graph and validate again before rendering. Remove an element when it is unsupported or irrelevant to the requested explanation; preserve necessary relationships. If validation is blocked by an unavailable or incompatible CLI, report the blocker instead of repeating an unchanged failure. Consult [validator errors and parser checks](references/graph-document.md#what-the-validator-will-catch) when diagnosing failures.

4. **Render and present.**

   ```bash
   npx @coldtea/pr-lens-cli render .pr-lens/graph.json --theme dark
   ```

   Render dark as the default theme unless explicitly requested. The SVGs, the manifest and `drawn.graph.json` land in `.pr-lens/`, which the CLI adds to the repository's .gitignore. Do not commit any of it. The SVGs, manifest, and `drawn.graph.json` are generated from the authored `.pr-lens/graph.json`; keep that source graph for local revisions.

   Resolve this skill's directory from the path used to load this `SKILL.md`, then build one self-contained report:

   ```bash
   node <skill-directory>/scripts/build-report.mjs \
     .pr-lens/drawn.graph.json .pr-lens/manifest.json .pr-lens/report.html
   ```

   The report embeds every SVG and adds the change summary, metrics, key connections, ordered flows, and changed source areas. Always open `.pr-lens/report.html` in an available local browser or artifact viewer. If none is available, give the user its absolute path. Do not finish by listing loose SVG files.

## What makes a document worth reading

- **Include what did not change.** A diagram of only the changed nodes says nothing about blast radius. The unchanged neighbours a change touches are the context; mark them `delta: "unchanged"`.
- **Lanes are the reader's mental model** (a runtime, a tier, a boundary), not the folder tree.
- Emphasize the connection the explanation centers on. Usually one hero edge is enough; add another only when it clarifies a distinct essential relationship.
- **Add a flow only when there is a sequence** worth animating. One good flow beats three thin ones.
- **Attach file refs** so the graph stays traceable to the local source.
- **There is no findings lens.** PR Lens is the comprehension layer, not another review bot. There is no field for a bug, a risk or a security note, and a document that invents one is rejected rather than trimmed.

## Choosing architecture views

Use [Choosing architecture views](references/graph-document.md#choosing-architecture-views) to select useful levels and nesting. One useful view is enough for a small change.

## Fixing a map instead of writing one

For this local authored workflow, correct `.pr-lens/graph.json`, validate, and render again. Add missing nodes and edges there. Do not patch generated SVGs or `drawn.graph.json`.

When the user wants reusable mapping rules across future inference runs, use [the config reference](references/config.md) for `.github/pr-lens.yml`. Overlays can rename, exclude, or assign lanes/groups; add missing nodes and edges in the authored graph. The config reference covers selectors, examples, validation, and unmatched corrections.

## What ships with this skill

| Resource                                            | Use it for                                                  |
| --------------------------------------------------- | ----------------------------------------------------------- |
| [starter.graph.json](references/starter.graph.json) | A small valid starting point with fictional data to replace |
| [graph-document.md](references/graph-document.md)   | Field definitions, limits, and architecture-view decisions  |
| [example.graph.json](references/example.graph.json) | A complete example with flows and a nested view tree        |
| [config.md](references/config.md)                   | Reusable mapping overlays                                   |
| [build-report.mjs](scripts/build-report.mjs)        | The self-contained local HTML report                        |
