# codex-provider

Replaces Pi's OpenAI Codex provider with Codex-compatible requests, transport, compaction, and durable checkpoint replay.

## Install

Follow the audited [local load-last deployment contract](docs/local-deployment.md); npm installation is not supported.

## Usage

OpenAI Codex requests compact and replay opaque checkpoints automatically when the active model and session are compatible.

## Configuration

The provider replacement is always active. See [design](docs/design.md) for ownership and remote-compaction failure policy.
