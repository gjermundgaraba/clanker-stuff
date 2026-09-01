# side

Adds a concurrent multi-turn /side conversation with an adaptive side panel.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/side/index.ts` as a local extension; npm installation is not supported.

## Usage

- Run `/side` or `/side <prompt>` to open or resume the side conversation.
- Use `Ctrl+/` to dismiss or reopen; configured `app.interrupt` (`Esc` by default) dismisses, configured `app.exit` (`Ctrl+D` by default) closes on an empty editor, and `Alt+Enter` inserts the latest response.
- The child receives a parent snapshot and normal Pi tools; its panel uses half width at 120+ columns and full width below that.
