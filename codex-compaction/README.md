# codex-compaction

Adds fail-closed OpenAI Codex remote compaction with durable opaque checkpoint replay.

## Install

Follow the audited [local load-last deployment contract](docs/local-deployment.md); npm installation is not supported.

## Usage

OpenAI Codex requests compact and replay opaque checkpoints automatically when the active model and session are compatible.
