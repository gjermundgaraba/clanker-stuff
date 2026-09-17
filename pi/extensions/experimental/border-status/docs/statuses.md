# Border statuses

The host displays extension-owned statuses at the right edge of Pi's editor top border. It preserves the working indicator, hidden-line label, editor input width, and keybindings. Statuses disappear when cleared or when their session/branch ends. They are not persisted or clickable.

## Icons

`/border-status icons inherit|nerd|unicode|ascii` saves the preference in `<agent-dir>/border-status.json` (normally `~/.pi/agent/border-status.json`):

```json
{ "version": 1, "iconFamily": "inherit" }
```

`inherit` reads the saved footer icon preference, even without footer loaded. With footer loaded, committed preference changes apply live. Unsaved footer previews do not change the border. The saved footer file is validated with the same full configuration parser as footer itself. Missing or invalid footer configurations use footer’s default icon family (Unicode). Font installation is not detected automatically.

Nerd mode falls back through `nerd`, `unicode`, `ascii`; Unicode falls back to ASCII; ASCII uses only the ASCII variant. An explicit empty glyph stops fallback and omits the icon. Glyph widths follow Pi's terminal-cell accounting. A terminal configured to render private-use glyphs differently can still misalign them.

## Producers

Use the [producer API and lifecycle guide](https://github.com/gjermundgaraba/clanker-stuff/blob/main/pi/packages/border-status-protocol/docs/producers.md) shipped with `@clanker-stuff/border-status-protocol`. The host extension is optional for producers.

## Ordering and overflow

Higher priorities appear first and survive overflow first. Equal priorities sort by owner and then key. The host replaces only unused trailing rule cells, keeping separation from the original left/center content. Entries that do not fit are omitted whole; there is no overflow counter. A smaller lower-priority entry may fit when a larger one does not. No entries means the original border is unchanged.

There is no entry-count admission limit; priority-based display overflow does not discard stored statuses. Admission does not depend on publication order.

## Compatibility and lifecycle

Tested with Pi 0.85.0. Contributes to the shared native editor alongside history, dollah-skills, and Vim, independent of registration order. With another editor installed, attachment is skipped and a shared status label explains the conflict. Availability follows mounting and session lifecycle, not terminal width or whether an entry fits. Rendering preserves the native border when there is insufficient space. Extensions that later replace the shared editor are unsupported.

Ask-question publishes `ask-question/inbox` for drafts (including paused drafts) and pending/uncertain deliveries. Sent or cancelled questionnaires do not count. Opening `/answers` or pressing Alt+I does not itself clear the indicator. The questionnaire widget remains visible independently while attention is required; the border count is supplementary, so both can appear at once.
