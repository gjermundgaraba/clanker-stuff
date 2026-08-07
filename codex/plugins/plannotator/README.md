# plannotator

Adds lightweight Plannotator review and annotation workflows to Codex.

## Install

Expose this directory through a Codex plugin marketplace, install `plannotator`, and start a new session.

## Usage

- `$plannotator:plannotator-review [--base <ref>]` reviews current changes or a pull request.
- `$plannotator:plannotator-annotate <target>` annotates a file, folder, or URL.
- `$plannotator:plannotator-last` annotates the latest Codex response.

## Requirements

The `plannotator` CLI must be available on `PATH`, and Node.js 24 or newer is required.
