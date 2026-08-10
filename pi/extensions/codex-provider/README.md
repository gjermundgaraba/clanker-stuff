# codex-provider

Replaces Pi's OpenAI Codex provider with Codex-compatible requests, fast mode, transport, compaction, and durable checkpoint replay.

## Install

Follow the audited [local load-last deployment contract](docs/local-deployment.md); npm installation is not supported.

## Usage

OpenAI Codex requests compact and replay opaque checkpoints automatically; run `/fast` to toggle priority service or `/codex-provider` to inspect provider and compaction status.

## Configuration

The provider replacement is always active. Observations use `~/.pi/agent/data/codex-provider/codex-provider.sqlite` by default; with Pi stopped, reset them with `rm ~/.pi/agent/data/codex-provider/codex-provider.sqlite*` (or use the equivalent `$PI_CODING_AGENT_DIR` path). See [design](docs/design.md) for ownership and failure policy, and [live canaries](docs/live-canary.md) for paid release verification.
