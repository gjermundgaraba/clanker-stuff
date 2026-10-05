# Upstream alignment

Use this file when maintaining the adaptation, not during ordinary diagram work.

Adapted from [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design/tree/562dbdf93ff3c3da630be4f90f4f6c2548175058), commit `562dbdf93ff3c3da630be4f90f4f6c2548175058` (release manifests 2.6.21), on September 10, 2026. The source is MIT licensed; retain [LICENSE](../LICENSE) with copied or adapted material.

The local design follows the user's “Rethinking skills and prompts for GPT-6 Astra” notes: concise discovery, conditional references, capable-model judgment, proportional constraints, and completion through a rendered artifact.

## Deliberate differences

- Explicit invocation through `disable-model-invocation: true` and `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
- A short entrypoint; type names and substantial geometry live in references rather than the discovery description.
- Supplied or project styling takes precedence; the default palette works without onboarding or approval. Styling changes belong in the output, not the installed skill.
- Density, accent counts, spacing grids, fonts, and connector shapes are contextual design defaults. Data fidelity, mathematical encodings, and relationships remain correctness requirements.
- References and examples are curated. Keep useful semantic constraints and distinct geometry; avoid reinstating repeated checklists, rigid itineraries, or arbitrary quotas.
- Import parsers remain reusable local tools. Source labels and metadata are data, and their bounded parsing is retained. Parser budget indicators are upstream heuristics, not instructions to delete content.
- Structural checking is adapted to the supported artifact contracts rather than upstream's font whitelist and pinned animation controller.
- Direct SVG authoring is supported. Export instructions distinguish portability from a browser rendering that depends on remote fonts.
- Plugin manifests, command wrappers, client-profile storage, onboarding, doctor workflows, galleries, and release infrastructure are outside this standalone skill.

Refresh upstream through the catalog's librarian helper when maintaining this copy. Compare the selected source revision and incorporate changes deliberately; the skill has no runtime dependency on a checkout cache. Validate changed helpers and links, and try representative generation/import/export requests when behavioral changes warrant it.
