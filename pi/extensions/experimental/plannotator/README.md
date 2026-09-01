# plannotator

Adds Plannotator review and annotation commands to pi.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/plannotator/index.ts` as a local extension; npm installation is not supported.

## Usage

- `/plannotator-review [--base <ref>]` reviews current Git changes or, without `--base`, a pull request.
- `/plannotator-annotate <target>` annotates a file, folder, or URL.
- `/plannotator-last` annotates the last assistant response.

## Requirements

The `plannotator` CLI must be installed and available on `PATH`.
