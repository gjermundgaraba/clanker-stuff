# stash

Adds a Ctrl+S shortcut and /pop-stash command for stashing and restoring editor text.

## Install

```bash
pi install npm:@clanker-stuff/stash
```

## Usage

- Press `Ctrl+S` to stash editor text. Pi processes in the same working directory share the ten newest drafts.
- When the terminal editor is empty, press `Ctrl+S` or run `/pop-stash` to restore the newest draft.
- After you submit a prompt, the newest draft returns if the editor is still empty.

## Configuration

Pi also binds `Ctrl+S` in its session, model, and thinking pickers. Remap `app.session.toggleSort`, `app.models.save`, and `app.thinking.save` in `keybindings.json` to avoid the startup conflict warning.

Close Pi processes using the old version before upgrading. On first use, stash imports the newest drafts from the legacy JSON file and keeps the original as a backup. If it can't import the file, stash warns and leaves it untouched.
