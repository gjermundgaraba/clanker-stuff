# plannotator-codex

Adds lightweight Plannotator review and annotation workflows to Codex.

## Install

Expose this directory through a Codex plugin marketplace, install `plannotator-codex`, and start a new session.

## Usage

- `$plannotator-codex:plannotator-review [--base <ref>]` reviews current Git changes or, without `--base`, a pull request.
- `$plannotator-codex:plannotator-annotate <target>` annotates a file, folder, or URL.
- `$plannotator-codex:plannotator-last` annotates the latest Codex response.

## Requirements

The `plannotator` CLI must be available on `PATH`, and Node.js 24 or newer is required.
