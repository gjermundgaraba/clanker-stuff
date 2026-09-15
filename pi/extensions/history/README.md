# history

Adds persistent prompt history with native ↑/↓ recall and Ctrl+R search to pi's editor.

## Install

```bash
pi install npm:@clanker-stuff/history
```

## Usage

- In a fresh session, press ↑/↓ to recall recent prompts from across projects; resumed sessions use their own history.
- Press Ctrl+R, type a query, press Ctrl+R again for older matches, then Enter to accept.
- Run `/history-import` to include prompts from existing sessions.

## Configuration

No configuration is required. See [history behavior](docs/behavior.md) for persistence and editor compatibility.
