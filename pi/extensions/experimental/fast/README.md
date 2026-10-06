# fast

Adds a local /fast toggle for best-effort native OpenAI subscription priority requests.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

From a repository checkout with dependencies installed (npm installation is not supported):

```bash
pi install ./pi/extensions/experimental/fast
```

## Usage

Run `/fast` to toggle this runtime's priority requests, or start with `--fast`; neither writes configuration.

## Configuration

Requires native OpenAI subscription OAuth; see [behavior and limits](docs/behavior.md).
