# Vendored install-anti-slop skill

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

Source directory: `skills/install-anti-slop/`, copied in full, including bundled plugin assets, references, and installer.

## Local adaptations

- Add `disable-model-invocation: true` to `SKILL.md` so Claude Code only invokes the skill explicitly.
- Add `agents/openai.yaml` with `policy.allow_implicit_invocation: false` so Codex only invokes the skill explicitly.
- Clarify that verification commands and test paths in `assets/anti-slop/vendor/eslint-stylistic/UPSTREAM.md` refer to the upstream anti-slop development repository, not this bundle or consumer repositories.
- Include the upstream Dillon Mulroy MIT notice at `assets/anti-slop/LICENSE` so it travels with this skill and the installed plugin alongside the independent Stylistic license.
- Add this provenance record. No installer or plugin behavior has been changed.

## Updating

Stage a refreshed upstream checkout at an explicit immutable commit and compare its complete `skills/install-anti-slop/` directory against the source revision recorded above and this local copy. Review upstream changes, refresh the complete bundle, and preserve the user-invocation-only settings and applicable documentation clarifications. Record any additional local adaptations and update this source revision only after reconciling the full bundle.

Keep the nested ESLint Stylistic provenance and `LICENSE` with the bundled assets. That record describes a dependency vendored by anti-slop; it does not identify this skill's source revision.

This file records catalog-level provenance and is not copied by `scripts/install.mjs`, which copies only `assets/anti-slop/`. When using this skill to install the plugin into a consumer repository, create the separate provenance record beside that repository's installed plugin entry point as directed by `SKILL.md`. Identify the actual installed source and any consumer-specific changes; do not replace the nested Stylistic record.
