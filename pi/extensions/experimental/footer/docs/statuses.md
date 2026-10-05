# Status producers

Extensions publish footer and border values with Pi's `ctx.ui.setStatus(key, text)`. No footer dependency or protocol is involved, and without this extension Pi's built-in footer shows the same statuses on its status line.

- **Key:** the extension name, or `<extension>.<name>` for several values, such as `background-tasks.pending`. Users place it as `status:<key>`.
- **Text:** one line. Style it with `ctx.ui.theme.fg(tone, text)`, choosing tones by the repository's [color conventions](https://github.com/gjermundgaraba/clanker-stuff/blob/main/docs/color.md), and include any icon as a literal character. Pass `undefined` to clear it.
- **Lifecycle:** publish at session start and after tree navigation. Pi clears every status on reload and session switch.

The footer renders statuses as Pi's footer does: line breaks and tabs become spaces, and styling is closed before the next widget. Styled text keeps the colors of the theme that was active when it was set until the producer publishes again.

Any extension's `setStatus` key can be placed. The default layout places `status:usage` in the second footer row; `status:ask-question`, `status:vim`, `status:background-tasks.pending`, and `status:background-tasks.active` in the editor border; and every other status in `footer.statuses`.
