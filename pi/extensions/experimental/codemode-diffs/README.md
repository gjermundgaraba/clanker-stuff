# codemode-diffs

Shows nested edit diffs beneath Code Mode results.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

From a repository checkout with dependencies installed (npm installation is not supported):

```bash
pi install ./pi/extensions/experimental/codemode-diffs
```

## Usage

- Use Code Mode normally; successful nested `edit` calls show syntax-highlighted diffs after the script finishes, even if it fails later.
- Press `Ctrl+O` to expand the diff preview; saved diffs remain visible when resuming with this extension loaded.
- Only `edit` results are captured, not `write` calls or shell changes; older sessions cannot recover missing diffs.

## Configuration

Uses Pi’s native `edit` tool; do not combine with another `edit` override. See [behavior and limits](docs/behavior.md).
