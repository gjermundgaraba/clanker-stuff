# codex-provider

Replaces Pi's OpenAI Codex provider with Codex-compatible requests, fast mode, transport, compaction, and durable checkpoint replay.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Follow the audited [local load-last deployment contract](docs/local-deployment.md); npm installation is not supported.

## Usage

OpenAI Codex requests compact and replay opaque checkpoints automatically; run `/code-mode` to toggle Code Mode, `/fast` to toggle priority service, or `/codex-provider` to inspect status.

## Configuration

The `/fast` preference is stored globally in `~/.pi/agent/codex-provider.json`. Observations use `~/.pi/agent/data/codex-provider/codex-provider.sqlite`; with Pi stopped, reset them with `rm ~/.pi/agent/data/codex-provider/codex-provider.sqlite*` (or use the equivalent `$PI_CODING_AGENT_DIR` paths). See [design](docs/design.md) for ownership and failure policy.
