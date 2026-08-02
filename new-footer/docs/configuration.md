# Footer configuration

Run `/footer` in TUI mode to edit the footer. The editor previews changes immediately but writes them only when you choose **Save**.

## Editor controls

- Arrow keys or `hjkl` select widgets and each cell's **+ Add** target; `Enter` grabs a widget or opens that cell's picker.
- The picker lists every widget not already placed and marks unavailable contributors as waiting.
- `Delete` or `Backspace` removes a widget from its cell; add it again through any cell's picker.
- `I` cycles icon families, `E` enables or disables the custom footer, and `W` cycles preview width.
- `R` restores the complete default layout; `S` saves, and `Q` or `Escape` closes without saving.
- `/footer inspect` shows values and layout decisions; `/footer doctor` shows ownership, config, collector, and protocol errors.

Pi exposes one custom-footer slot. If another extension replaces this host, it stays inactive instead of fighting for ownership. Disable the competing footer or change extension load order, then reload.

## File format

The global file is `footer.json` under pi's effective agent directory, normally `~/.pi/agent/footer.json`. A missing file uses Default without creating one. The host reloads it at session start and whenever `/footer` opens.

```json
{
  "version": 1,
  "enabled": true,
  "iconFamily": "unicode",
  "separator": "·",
  "rows": [
    {
      "left": ["footer.cwd", "footer.git"],
      "center": [],
      "right": ["footer.model", "footer.thinking"]
    },
    {
      "left": ["footer.context"],
      "center": [],
      "right": ["clanker.usage.active"]
    },
    {
      "left": ["footer.widgets", "footer.statuses"],
      "center": [],
      "right": []
    }
  ],
  "widgets": {
    "footer.git": { "enabled": false }
  }
}
```

`rows` accepts one to three rows. Each widget ID may appear once across `left`, `center`, and `right`; the first duplicate wins and `/footer doctor` reports the rest. Use `status:<setStatus key>` for an individual native status. Widget IDs and native status keys containing terminal controls are rejected. Unknown IDs remain saved so optional contributors can appear later.

`iconFamily` is `ascii`, `unicode`, or `nerd`. Row arrays control placement and order; `widgets` records explicit enabled or omitted state. At narrow widths, widgets stay in their configured groups and truncate toward the center unless a rich widget provides another truncation hint.

The format is strict: unknown or invalid fields reject the whole file. The invalid file remains untouched, Default renders in memory, and the editor asks for a second explicit Save before replacing it.
