# vim

Adds composable Vim editing with transactional undo and visual selections to pi.

**Experimental:** interfaces and behavior may change incompatibly; not a stable daily driver.

## Install

```bash
pi install /absolute/path/to/clanker-stuff/pi/extensions/experimental/vim
```

## Usage

Start typing in Insert mode; press Escape for Normal mode, then `i` to resume typing. History, skill mentions, and border-status compose automatically.

## Requirements

Pi 0.86.1 is the tested host. See [commands and boundaries](docs/design.md) before use; Vim is skipped when another custom editor owns the session.
