# AGENTS

This repository contains agent tooling for Pi, Claude Code, and Codex. Pi extensions live under `pi/extensions/`, with unstable ones under `pi/extensions/experimental/`; host plugins live under `claude/plugins/` and `codex/plugins/`.

## General instructions

- When creating or editing any `README.md`, read and follow `docs/readme-style.md` first.
- When creating or restructuring an extension package, follow the layout in `docs/extension-structure.md`.
- Keep tests in the smallest layer that proves the behavior: unit by default, integration only for real `AgentSession` behavior, smoke only for discovery, runtime wiring and high-level verification when needed.
- For session-persisted tool schemas such as `ask_question`, keep `parameters` strict. When the schema evolves, add `prepareArguments(args)` to migrate old persisted calls instead of adding deprecated compatibility fields to the public schema.
- For any custom tool that mutates files, use `withFileMutationQueue()` around the full read/modify/write critical section, keyed by the resolved absolute target path, so it participates in pi's per-file mutation queue.
- Never suggest "upstreaming a change to pi itself". If we can't do something in an extension today, we can't do it today.

## Upstream pi reference

When working on pi extensions, sdk, themes or TUI, read the documentation, examples and APIs from Pi's source:

1. Resolve a reusable, read-only checkout of `earendil-works/pi` at `~/.cache/checkouts/github.com/earendil-works/pi`, checked out at `v0.84.2`. Partial-clone it if absent. Never edit the shared checkout.
2. Treat `<pi>/packages/coding-agent` as the documentation root. Read its `README.md` and relevant files under `docs/` and `examples/` completely, following Markdown cross-references. Resolve `docs/...` and `examples/...` there, not relative to this repository.
3. Use: extensions (`docs/extensions.md`, `examples/extensions/`), themes (`docs/themes.md`), skills (`docs/skills.md`), prompt templates (`docs/prompt-templates.md`), TUI (`docs/tui.md`), keybindings (`docs/keybindings.md`), SDK (`docs/sdk.md`, `examples/sdk/`), providers (`docs/custom-provider.md`), models (`docs/models.md`), packages (`docs/packages.md`), and environment variables (`docs/environment-variables.md`).
4. Before reimplementing pi functionality, search `<pi>/packages/`, its public exports, and its examples.

## Commands

Most work targets one extension package. Prefer package-scoped validation first, then broaden only when the change is cross-cutting or before final handoff.

Use the package name from the extension's `package.json`, e.g. `@clanker-stuff/ask-question`, and the directory path, e.g. `pi/extensions/ask-question`.

### Single-extension validation

- `pnpm --filter <package-name> exec vitest run --project unit` — run that extension's unit / contract / TUI tests from the package workspace.
- `pnpm --filter <package-name> exec vitest run --project integration` — run that extension's integration tests, if any.
- `pnpm --filter <package-name> exec vitest run --project smoke` — run that extension's smoke tests, if any.
- `pnpm test:unit <directory>` — alternate unit-test form from the repo root; do not use `pnpm test:unit -- <directory>` because the extra `--` can prevent Vitest path filtering from behaving as intended.
- `pnpm exec ultracite check <directory>` — lint/format-check one extension (Oxlint + Oxfmt via Ultracite).
- `pnpm exec oxfmt <directory>` — format one extension.
- `pnpm typecheck` — run repo TypeScript checking. This is currently repo-wide; if it fails, distinguish failures caused by the current extension from pre-existing unrelated failures.

### Repo-wide validation

Use these for broad or cross-cutting changes, README policy changes, shared code changes, or final confidence when practical.

- `pnpm install` — install dependencies.
- `pnpm check:all` — run format, lint, typecheck, repo-local test/boundary checks, and test in sequence.
- `pnpm check:readmes` — validate package README.md files against the repo README policy.
- `pnpm check:tests` — validate package test coverage presence, required higher-layer coverage, and discovery-safe relative imports.
- `pnpm format` — check formatting with Oxfmt across the repo.
- `pnpm format:fix` — apply Oxfmt formatting across the repo.
- `pnpm lint` — run Ultracite check with type-aware Oxlint (Oxfmt + Oxlint; full Ultracite core+vitest presets) plus README validation across the repo.
- `pnpm lint:fix` — run Ultracite fix with type-aware Oxlint (Oxfmt + Oxlint) then re-run README validation.
- `pnpm check` / `pnpm fix` — Ultracite-only aliases with type-aware Oxlint (no README checks).
- `pnpm test` — run the full Vitest suite across unit, integration, and smoke layers.
- `pnpm test:unit` — run all `*.test.ts` unit / contract / TUI coverage.
- `pnpm test:integration` — run all `*.integration.test.ts` real-`AgentSession` coverage.
- `pnpm test:smoke` — run all `*.smoke.test.ts` discovery and runtime smoke coverage.
