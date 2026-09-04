# codex-provider

Replaces Pi's OpenAI Codex provider with Codex-compatible requests, fast mode, transport, compaction, and durable checkpoint replay.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

> [!NOTE] This is an unofficial extension that talks to the OpenAI Codex backend with your own ChatGPT sign-in. It is not affiliated with or endorsed by OpenAI.

## Compatibility goal

Together with [`subagents`](../subagents), this package minimizes model-facing distribution shift from the native Codex CLI harness. Every model-facing surface these packages own—requests, tools, schemas, descriptions, results, ordering, transport, context, and lifecycle behavior—should match the pinned Codex implementation whenever Pi can execute that contract truthfully. See the [Codex source baseline](docs/codex-baseline.md) for the decision rule and documented boundaries.

## Install

Follow the audited [local load-last deployment contract](docs/local-deployment.md); npm installation is not supported.

## Usage

OpenAI Codex requests compact and replay opaque checkpoints automatically; with [`subagents`](../subagents) loaded first, run [`/ultra`](docs/ultra.md) or start with `--ultra` for catalog-resolved proactive V2 delegation, `/code-mode` for Code Mode, `/fast` for priority service, or `/codex-provider` for status.

## Configuration

The `/fast` preference is stored globally in `~/.pi/agent/codex-provider.json`. Observations use `~/.pi/agent/data/codex-provider/codex-provider.sqlite`; with Pi stopped, reset them with `rm ~/.pi/agent/data/codex-provider/codex-provider.sqlite*` (or use the equivalent `$PI_CODING_AGENT_DIR` paths). See [design](docs/design.md) for ownership and replay rules.
