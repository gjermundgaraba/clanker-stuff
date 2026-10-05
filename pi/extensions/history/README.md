# history

Adds persistent prompt history with native ↑/↓ recall and Ctrl+R search to pi's editor.

## Install

```bash
pi install npm:@clanker-stuff/history
```

## Usage

- Press ↑/↓ to recall your most recent prompts from across projects.
- Press Ctrl+R, type a query, press Ctrl+R again for older matches, then Enter to accept.
- Run `/history-import` to include prompts from existing sessions.

## Configuration

Pi's session picker also binds Ctrl+R; set `app.session.rename` to another key in `keybindings.json` to silence the startup conflict warning. See [history behavior](docs/behavior.md).
