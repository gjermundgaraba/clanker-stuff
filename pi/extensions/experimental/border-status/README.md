# border-status

Shares the editor top border between extension-owned status indicators.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Run `pi install ./pi/extensions/experimental/border-status` from this repository.

## Usage

- Enabled producers appear at the right of the editor's top border; ask-question shows a mail icon and pending count.
- Use `/border-status icons inherit|nerd|unicode|ascii` to select icons; the default inherits the footer preference.

## Configuration

See [configuration and producer integration](docs/statuses.md). Nerd icons require a Nerd Font configured in your terminal.
