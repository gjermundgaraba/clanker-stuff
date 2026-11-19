# Behavior and limits

## Highlighting

Nested edits use `@pierre/highlights` to tokenize complete before/after source independently, up to a combined 128 KiB of UTF-8 source and 4,000 lines. Larger inputs skip tokenization and keep the plain diff. Only UTF-16 span ends and semantic syntax roles for displayed diff rows are saved; complete file snapshots and concrete colors are not persisted. The active Pi theme supplies syntax colors when the diff renders. Single-line replacements retain inverse word emphasis.

Context rows use the old side's lexer state because Pi numbers context in the old file. The new side supplies added rows. Unknown languages, old saved diffs, malformed spans, and highlighting errors retain Pi's normal diff presentation. Very long lines are scanned for lexer state but can be left without syntax styling to bound token allocation.

## Native edit delegation

The extension registers an `edit` wrapper that delegates file mutation to Pi's built-in edit implementation. Its injected read/write operations observe the exact bytes inside Pi's existing per-file mutation queue; it does not reread files afterward or acquire the same queue twice. Direct edits retain normal native rendering and skip Highlights.

Do not combine it with another extension that replaces `edit`, including remote-filesystem edit tools: registrations replace one another rather than composing. If another edit tool wins, diff capture still accepts its display diffs, but source-based highlighting is unavailable.

## Saved diffs

Successful nested `edit` calls are shown after Code Mode completes, including when the script later fails. `write`, shell mutations, and edits hidden inside other custom tools are not captured. File contents can appear in the displayed diff, as with Pi's native edit output, but full-file source is transient.

Each Code Mode result can carry at most 64 KiB of serialized diff details from this extension, including paths, call IDs, syntax spans and the omission count. Diffs are considered in result order. Diffs keep syntax when it fits, fall back to plain text when only the plain diff fits, and are omitted otherwise. Later smaller diffs can still be saved. The heading reports omitted diffs even if none were saved. This budget does not limit Pi's own call metadata or script output.
