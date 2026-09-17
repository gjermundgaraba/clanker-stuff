# Vim v1

## Contract

This is a prompt editor, not a terminal running Vim. Pi owns completion, submission, images, history navigation, and application shortcuts. The modal engine operates on one native Pi document. There is no second mutable text buffer, subprocess backend, public plugin API, configuration file, or legacy compatibility path.

Start in Insert. Escape dismisses completion first, then leaves Insert or Visual; Escape in Normal delegates to Pi. Configured submit/newline bindings remain native. Ctrl+R means history search in Insert, redo in Normal/Visual, and result cycling while the history widget has focus. The unnamed register is internal, with no automatic system clipboard reads or writes.

## Commands

- Modes: `i I a A o O`, `v V`, Escape.
- Motions: `h j k l`, `w b e W B E`, `0 ^ $`, `gg G`, `f F t T`, `%`. Vertical motions use logical lines.
- Operators: `d c y` plus motions; `dd cc yy`; counts before operators and motions multiply, capped at 1,000.
- Text objects: `iw aw iW aW` (counted `iw` counts whitespace, and a word object extends a forward Visual selection), quotes (`" '` and backtick), paired `() [] {} <>`; `i`/`a` objects also work in Visual.
- Edits: `x X s S D C` as synonyms of `dl dh cl cc d$ c$` (in Visual, lowercase edits the selection and uppercase its whole lines), `r`, `~`, `J` (in Visual, the selected lines), `p P` (Visual `p` exchanges the selection with the register; `P` keeps it; both reconcile linewise and characterwise text with the selection's type).
- History: `u`, the configured native undo binding, Ctrl+R; changes and their following Insert sessions form one transaction. The native binding undoes the same transactions but leaves Insert active; `u` and Ctrl+R end in Normal.
- Repeat: `.` records semantic edits and inserted text, never callback or terminal-key replay. Submission and external replacement invalidate it.

Search, Ex, macros, named registers, Replace mode, block selection, leader mappings, escape chords, and prompt-specific objects are deferred. Sticky vertical columns are not implemented. Pi's Ctrl/Alt editing bindings pass through in Normal and Visual with their native between-characters cursor semantics; their changes are ordinary undoable transactions. Visual dot records selection extent rather than absolute offsets. These are explicit limits, not simulated Vim behavior.

## Architecture

`core/document.ts` owns grapheme/paste-atom boundaries. `core/parser.ts` consumes a bounded command grammar. `core/motions.ts` resolves motion targets and objects. `core/commands.ts` produces a single edit, cursor, mode, and optional yank. No core module imports Pi or performs I/O.

`transactions.ts` owns bounded undo/redo and cursor-anchored insertion changes accumulated into one semantic replacement. Routine observations and modal undo checkpoints share immutable document views: text, cursor, and owned paste atoms. Only history preview captures the complete native undo and navigation state. `runtime.ts` connects commands and native input to transactions; the host reports only changes made outside the engine, so its own edits, restores, and previews need no re-entrancy guard. `lifecycle.ts` publishes mode through the existing border-status protocol, falling back to a status label when no border host is available.

`@clanker-stuff/editor` owns the one factory, native document adapter, paste routing, and rendering. History contributes recall entries and snapshot previews; dollah-skills contributes foreground spans; Vim contributes selection backgrounds; border-status contributes the top border. Each contribution slot has one owner and a release that leaves a later owner in place. Contributions do not wrap factories or patch global prototypes. Installation order does not determine ownership. The factory's ownership key carries the host's shape version; a copy built for another shape sees a foreign editor.

## Safety and lifecycle

Native retrieval and submission share the adapter's single-pass paste expansion; marker-looking payload content remains literal. Modal checkpoints own paste payloads; restoring one reconstructs the native paste map and counter and clears native undo. Registers and the adapted native kill ring materialize payloads rather than retaining marker IDs. Only text entering the document from outside it (a put or a repeated insertion) is encoded; edits derived from the collapsed document, such as `J`, keep its markers as they are. Graphemes and recognized collapsed paste markers are indivisible. Terminal paste retains Pi's normalization rules and is routed before modal keys, as complete packets framed by Pi's StdinBuffer (a standalone Escape remains immediate). Register insertion is bounded to one million UTF-16 units; undo retains up to 100 changes.

The editor's public `getText()` exports expanded text because Pi transfers only that string during editor replacement. Internal editing uses the adapter's collapsed view. Reload/handoff therefore preserves prompt content rather than exporting orphaned markers, but resets folding, modal state, and undo; Pi's receiving editor applies its normal setText normalization (including tabs and line endings). No attempt is made to preserve private snapshots across reload or another editor owner. Pi also round-trips `getText()` through `setText()` on the same editor when a non-overlay custom view closes; setting the text the editor already holds is therefore not a replacement and preserves folding, cursor, undo, and mode.

History preview cancellation restores the complete document, cursor, native undo, and Vim state. Accepting history starts a fresh editing boundary. A revision check prevents previews from overwriting intervening edits. The history database format is unchanged.

The adapter validates its required private Pi surface once. Pi 0.85.0 is the tested target, not a claim of compatibility with arbitrary Pi releases. With an unrelated editor factory installed, or when validation fails inside Pi's factory call, attachment is skipped and a shared status label explains why; a failed validation leaves a stock Pi editor mounted rather than an empty editor container. Skill completion/injection, history persistence, and text-only history search remain available. There is no alternate editor implementation or factory wrapping.

## Validation

Pure core tests and headless Neovim comparisons (with Vim's `startofline` default, which linewise deletes here follow) verify text and UTF-16 cursor positions. Real Pi Editor contract tests cover insertion, undo/redo, dot, graphemes, payloads, completion, fast submit, preview, and all 24 contribution orders. The Neovim comparisons are skipped explicitly when `nvim` is not installed. These tests do not constitute manual terminal certification.
