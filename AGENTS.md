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

1. Resolve a reusable, read-only checkout of `earendil-works/pi` at `~/.cache/checkouts/github.com/earendil-works/pi`, checked out at `v0.84.3`. Partial-clone it if absent. Never edit the shared checkout.
2. Treat `<pi>/packages/coding-agent` as the documentation root. Read its `README.md` and relevant files under `docs/` and `examples/` completely, following Markdown cross-references. Resolve `docs/...` and `examples/...` there, not relative to this repository.
3. Use: extensions (`docs/extensions.md`, `examples/extensions/`), themes (`docs/themes.md`), skills (`docs/skills.md`), prompt templates (`docs/prompt-templates.md`), TUI (`docs/tui.md`), keybindings (`docs/keybindings.md`), SDK (`docs/sdk.md`, `examples/sdk/`), providers (`docs/custom-provider.md`), models (`docs/models.md`), packages (`docs/packages.md`), and environment variables (`docs/environment-variables.md`).
4. Before reimplementing pi functionality, search `<pi>/packages/`, its public exports, and its examples.

## Commands

Most work targets one extension package. Prefer package-scoped validation first, then broaden only when the change is cross-cutting or before final handoff.

Use the package name from the extension's `package.json`, e.g. `@clanker-stuff/ask-question`, and the directory path, e.g. `pi/extensions/ask-question`.

### Single-extension validation

- `vp test --project unit <directory>` — run that extension's unit / contract / TUI tests.
- `vp test --project integration <directory>` — run that extension's integration tests, if any.
- `vp test --project smoke <directory>` — run that extension's smoke tests, if any.
- `vp check <directory>` — check formatting and lint the extension; type checking remains repo-wide.
- `vp fmt <directory>` — format one extension.

### Repo-wide validation

Use these for broad or cross-cutting changes, README policy changes, shared code changes, or final confidence when practical.

- `vp install` — install dependencies with the pinned pnpm version.
- `vp check` / `vp check --fix` — format, lint, and type-check the repository.
- `vp test` — run all unit, integration, and smoke projects; use `--project <name>` to select one.
- `vp run check:readmes` / `vp run check:tests` — run repository README or test-boundary policy checks.
- `vp run ready` — run every static check, policy check, and test.
