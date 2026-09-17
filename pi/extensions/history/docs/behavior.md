# History behavior

History is global across projects and stored as text in `<agent-dir>/data/history/history.sqlite`. The agent directory defaults to `~/.pi/agent`. Prompts can contain sensitive information; the extension creates its data directory with owner-only access. History is not sent to the model unless you submit a recalled prompt.

## Native recall

Fresh, empty sessions query only the latest 100 distinct saved prompts for Pi's editor. Full saved history is loaded lazily when Ctrl+R is first opened, not during session startup. Pi handles ↑/↓, multiline cursor movement, autocomplete, and draft restoration normally. Submitting a prompt adds it to native history through Pi's normal submission path.

Resumed and forked sessions use their own session history instead of global history. Reloading a populated session reconstructs its active-branch history; an empty, unbranched session loads recent global history. Native history is a startup snapshot: imports and writes from other running sessions become available to arrows in the next fresh session, not during an existing browsing sequence.

The extension contributes to this repository's shared native editor alongside dollah-skills, Vim, and border-status. There is one factory, independent of installation order. With another editor installed, arrow-key recall is unavailable; search, recording, and importing history still work. The existing editor is left untouched and a shared status label explains the conflict.

## Search and persistence

Ctrl+R searches the full saved history, case-insensitively. Repeated Ctrl+R or ↑ selects older matches; Ctrl+S or ↓ selects newer matches. Pi's configured input-submit key (Enter by default) accepts into the editor without submitting. Its configured cancel key (Escape by default), or Ctrl+C, restores the draft. The search hint reflects the current bindings. The query uses Pi's single-line input editing, including cursor movement, word deletion, and undo. Ctrl+U clears the whole query as one undoable edit. The focused query widget owns keyboard input and the terminal cursor. Closing search restores the actual pre-search focus target, including the shared editor. Search is suspended while another component has focus: dialogs receive their own input. It resumes if Pi returns focus to the query; otherwise Ctrl+R starts a fresh search. Cancel restores a complete snapshot, including cursor, paste payloads, undo, and modal state; under another editor, search previews and restores the text only. Accept creates a fresh editing boundary. If another component edits the draft, the search relinquishes preview ownership and cannot overwrite that edit. An interrupted paste is discarded when focus moves away. Cleanup restores an unchanged preview to its original draft without stealing focus or overwriting newer editor text. Pasted control characters are removed.

Live recording includes interactive prompt input and user `!`/`!!` commands. RPC and extension-injected input are excluded. Extension slash commands bypass Pi's `input` event and are not persistently recorded. Historical session extraction cannot distinguish interactive from automated user messages and may contain expanded skills or templates rather than the original input.

`/history-import` imports user prompts and bash commands from existing session files without modifying those files. It scans the default session tree plus the current custom session directory, if any. Import is explicit, not a startup scan. Each candidate file is streamed once, retaining only extracted prompts and commands until its transaction commits. Malformed JSON and malformed prompt messages are skipped individually. Repeated imports deduplicate by text and retain the most recent timestamp.

History has no automatic expiry. Ctrl+R refreshes from SQLite when another process has changed the database. A persistence error warns once per session; unsaved prompts remain searchable in memory across database refreshes and imports, but are lost when the session closes unless subsequently persisted. Import stops during session shutdown, and already committed files remain imported.

In `--no-session` mode, history stays in memory and never reads or writes the persistent store. Print, JSON, and RPC modes do not activate the extension.
