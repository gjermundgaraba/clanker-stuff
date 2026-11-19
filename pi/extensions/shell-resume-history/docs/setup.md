# Shell setup

The shell hook creates a private inbox for each interactive shell instance. Pi records the session path there on exit, and the same shell quotes it for history before displaying the next prompt.

The command is `pi --session <session file>`. Pi opens a session file in the session's own project directory, so the command resumes it from any shell directory.

Each nested shell receives its own inbox. Re-sourcing the hook in the same shell reuses that shell's existing inbox.

## Fish

Copy `shell/fish.fish` to Fish's startup directory:

```bash
mkdir -p ~/.config/fish/conf.d
cp /path/to/clanker-stuff/pi/extensions/shell-resume-history/shell/fish.fish \
  ~/.config/fish/conf.d/shell-resume-history.fish
```

This requires a Fish version that supports `history append`.

## Zsh

Source `shell/zsh.zsh` from `~/.zshrc`:

```zsh
source /path/to/clanker-stuff/pi/extensions/shell-resume-history/shell/zsh.zsh
```

## Upgrading

Update the shell hook whenever you update the extension: older hooks ignore the records newer versions write. If you copied the Fish hook, copy it again; then start a new shell.
