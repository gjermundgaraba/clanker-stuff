# plannotator

Adds Plannotator review and annotation commands to pi.

## Install

```bash
pi install npm:@clanker-stuff/plannotator
```

## Usage

- `/plannotator-review [--base <ref>]` reviews current Git changes or, without `--base`, a pull request.
- `/plannotator-annotate <target>` annotates a file, folder, or URL.
- `/plannotator-last` annotates the last assistant response.

## Requirements

The `plannotator` CLI must be installed and available on `PATH`.
