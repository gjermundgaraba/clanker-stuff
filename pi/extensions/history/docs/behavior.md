# History behavior

History is global across projects and stored as text in `<agent-dir>/data/history/history.sqlite`. The agent directory defaults to `~/.pi/agent`. Prompts can contain sensitive information; the extension creates its data directory with owner-only access. History is not sent to the model unless you submit a recalled prompt.

## Native recall

Every session seeds Pi's editor with the latest 100 distinct saved prompts. Pi handles ↑/↓, multiline cursor movement, autocomplete, and draft restoration normally. When Pi starts in a resumed session, it adds that session's own prompts on top. Native history is a startup snapshot: prompts saved by other running sessions reach ↑/↓ in the next session.

Recall uses this repository's shared native editor, alongside dollah-skills and Vim. With another editor installed, ↑/↓ recall is unavailable; search, recording, and importing still work.

## Search

Ctrl+R replaces the editor with a search line and a preview of the selected match until you accept or cancel; the draft is not modified while searching. Matching is case-insensitive and literal. Repeated Ctrl+R or Pi's configured selection-up key (↑ by default) selects older matches; Ctrl+S or the selection-down key (↓ by default) selects newer matches. Pi's configured input-submit key (Enter by default) puts the match into the editor without submitting; its configured cancel key (Escape by default), or Ctrl+C, leaves the draft as it was. The query uses Pi's single-line input editing. Control characters are removed from pasted queries.

Ctrl+R conflicts with Pi's `app.session.rename`, which only applies inside the session picker. Pi lets the extension shortcut win in the editor and lists the conflict under startup extension issues. To remove the warning, map the action to another key in `<agent-dir>/keybindings.json`, for example `{ "app.session.rename": "alt+r" }`, then run `/reload`.

## Recording and persistence

Live recording includes interactive prompt input and user `!`/`!!` commands. RPC and extension-injected input are excluded. Extension slash commands bypass Pi's `input` event and are not recorded.

Search reads a snapshot of the database, re-read after another process writes to it, after an import, and when Pi reloads the extension. If a write fails, the extension warns once per session; the prompt stays searchable only until the snapshot is next re-read. History has no automatic expiry.

In `--no-session` mode, or when the database cannot be opened, history is kept in a private in-memory database for the session and never reads or writes the persistent store. Print, JSON, and RPC modes do not activate the extension.

## Importing and rebuilding

`/history-import` imports user prompts and bash commands from existing session files without modifying them. It scans the default session tree plus the current custom session directory, if any. Each file is streamed once and committed as one transaction; malformed lines are skipped individually. Repeated imports deduplicate by text and keep the most recent timestamp. Import stops during session shutdown, and already committed files remain imported.

Pi stores skill invocations expanded. Import recovers `/skill:name args` instead of the skill file contents; a message from earlier dollah-skills versions, which prepended one skill per `$name` mention, keeps its first skill as `/skill:name`, followed by its typed text and mentions. History saved by earlier versions may still contain expanded skills. To rebuild, quit Pi, delete `history.sqlite` and its `-wal` and `-shm` files, start Pi, and run `/history-import`. A rebuild keeps only prompts still present in session files.
