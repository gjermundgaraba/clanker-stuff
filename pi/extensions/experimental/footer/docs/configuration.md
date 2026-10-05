# Footer configuration

Run `/footer` in TUI mode to edit the layout. Pi's editor opens `footer.json`; saving validates the text, writes the file, and applies it immediately. An invalid edit reopens with your text after an error names the problem. `/footer reset` writes the default layout. `/footer inspect` lists every widget with its placement, current text, whether the last render truncated it, and recent errors.

The file is `footer.json` under pi's agent directory, normally `~/.pi/agent/footer.json`. A missing file uses the default without creating one, and a symlinked file is written through to its target. An invalid file stays untouched: the default renders and a warning names the problem. The host reads the file at session start and whenever `/footer` opens.

## File format

The default layout:

```json
{
  "iconFamily": "unicode",
  "rows": [
    { "left": ["footer.cwd", "footer.git"], "right": ["footer.model", "footer.thinking"] },
    { "left": ["footer.context"], "right": ["status:usage"] },
    { "left": ["footer.statuses"], "right": [] }
  ],
  "border": [
    "status:ask-question",
    "status:vim",
    "status:background-tasks.pending",
    "status:background-tasks.active"
  ],
  "hidden": []
}
```

- `rows` holds the footer lines, one per entry. `left` anchors to the left edge and `right` to the right edge. At narrow widths widgets share the space and truncate toward the middle of the line; the working directory keeps its end.
- `border` lists widgets drawn at the right end of the editor's top border, in order: native statuses or built-ins, but not `footer.statuses`. A widget that does not fit is skipped and shown nowhere, and a later one may still fit. The border uses the shared editor; while another custom editor is installed, including one installed later, border statuses appear in `footer.statuses` instead and border built-ins are hidden.
- `hidden` lists native statuses (`status:<key>`) to leave out of `footer.statuses`.
- `iconFamily` is `ascii`, `unicode`, or `nerd` for built-in widget icons. Nerd icons need a Nerd Font in your terminal.

All four fields are required. Unknown fields, an ID listed twice across rows, border, and hidden, a non-status entry in hidden, or `footer.statuses` in the border reject the whole file. Unknown widget IDs are kept but ignored; the session-start warning and `/footer inspect` name them.

## Widgets

| ID                   | Shows                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `footer.cwd`         | Working directory.                                                                                                                                                        |
| `footer.git`         | Git branch, as Pi reports it.                                                                                                                                             |
| `footer.git.details` | Staged `+`, unstaged `~`, untracked `?`, ahead `↑`, and behind `↓` counts. Runs `git status` at session start, after each turn, and on branch changes, only while placed. |
| `footer.model`       | Selected model. When the branch's last successful response used another model, `selected: … · last: …`, including physical routes behind virtual models.                  |
| `footer.thinking`    | Thinking level, split the same way.                                                                                                                                       |
| `footer.context`     | Context use against the window. Shows `?` while unknown, such as after compaction until the next response.                                                                |
| `footer.session`     | Session name, elapsed time, tokens, cache, and cost across every entry, including compaction, branch summaries, and standalone usage such as cache warming.               |
| `status:<key>`       | One native status set with `ctx.ui.setStatus(key, text)`.                                                                                                                 |
| `footer.statuses`    | Every native status not placed elsewhere or hidden, sorted by key.                                                                                                        |
