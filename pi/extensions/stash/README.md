# stash

Adds a Ctrl+S shortcut and /pop-stash command for stashing and restoring editor text.

## Install

```bash
pi install npm:@clanker-stuff/stash
```

## Usage

- Press `Ctrl+S` to stash editor text, or to pop the latest stash when the editor is empty.
- After you submit a prompt, the latest stash returns to the editor.
- Run `/pop-stash` to pop the latest stash manually.

## Configuration

Pi also binds `Ctrl+S` in its session, model, and thinking pickers. Remap `app.session.toggleSort`, `app.models.save`, and `app.thinking.save` in `keybindings.json` to avoid the startup conflict warning.
