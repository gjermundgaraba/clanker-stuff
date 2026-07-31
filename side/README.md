# side

Adds a concurrent multi-turn /side conversation with an adaptive side panel.

## Install

```bash
pi install npm:@clanker-extensions/side
```

## Usage

- Run `/side` or `/side <prompt>` to open or restore the side conversation.
- Use `Ctrl+/` to switch focus, `Esc` to hide, `Ctrl+D` on an empty side editor to close, and `Alt+Enter` to insert the latest response and hide the panel.
- The child receives a parent snapshot and normal Pi tools; its panel uses half width at 120+ columns and full width below that.
