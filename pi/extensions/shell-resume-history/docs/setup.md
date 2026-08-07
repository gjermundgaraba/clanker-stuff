# Shell setup

The shell hook creates a private inbox for each interactive shell instance. Pi writes its resume command there on exit, and the same shell imports it before displaying the next prompt.

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

Each nested shell receives its own inbox. Re-sourcing the hook in the same shell reuses that shell's existing inbox.
