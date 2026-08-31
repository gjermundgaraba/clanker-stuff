# side

Adds a concurrent multi-turn /side conversation with an adaptive side panel.

## Install

```bash
pi install npm:@clanker-stuff/side
```

## Usage

- Run `/side` or `/side <prompt>` to open or resume the side conversation.
- Use `Ctrl+/` to dismiss or reopen; configured `app.interrupt` (`Esc` by default) dismisses, configured `app.exit` (`Ctrl+D` by default) closes on an empty editor, and `Alt+Enter` inserts the latest response.
- The child receives a parent snapshot and normal Pi tools; its panel uses half width at 120+ columns and full width below that.
