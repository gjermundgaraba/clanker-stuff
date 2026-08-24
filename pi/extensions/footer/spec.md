# Footer replacement acceptance

## Status

This file contains only the acceptance gates for `footer/`. Normative behavior lives in `architecture.md`; supporting evidence lives in `research.md`.

## Required product behavior

- One cooperative TUI footer host owns pi's replace-only footer slot.
- Existing native statuses compose as configurable virtual widgets.
- Rich contributors publish strict version-1 snapshots over `pi.events`.
- Cwd, model, thinking, context, Git, and session widgets remain built in.
- Provider quota collection remains in the standalone `usage` extension.
- One strict global configuration and one spatial `/footer` editor control layout.
- `/footer inspect` and `/footer doctor` explain layout and operational failures.

## Non-goals

- Wrapping arbitrary custom footer owners.
- Migrating the old footer's internal configuration.
- Arbitrary JavaScript or shell widgets.
- Project-specific footer configuration or file watching.
- Presets, responsive shrinking modes, hidden benches, or per-widget settings screens.

## Acceptance gates

### Lifecycle and protocol

- TUI sessions install the footer only when enabled.
- Disable restores pi's built-in footer.
- Replacement changes ownership to `replaced` without automatic reinstallation.
- Session shutdown removes every listener, timer, collector, and captured context.
- Each session has a fresh instance ID; stale messages cannot mutate the registry.
- Producer-first and host-first load order reach the same state.
- Invalid messages preserve the previous snapshot and never throw through the event bus.
- Rich-widget and protocol-error limits remain bounded.

### Rendering

- `render()` performs no asynchronous, filesystem, network, or process work.
- Every line fits widths from 1 through 120 columns.
- Left, center, and right groups preserve configured order and alignment.
- Group defaults and producer truncation hints behave as documented.
- Native values remove unsafe controls while preserving safe SGR styling.
- Control-bearing native keys do not become widgets.
- One failed widget cannot suppress unrelated widgets.
- Unexpected top-level failure returns no custom rows and records the error.

### Configuration

- Missing config uses Default without creating a file.
- Unknown or invalid fields reject the whole file.
- Invalid source files remain untouched and require confirmation before replacement.
- Saves validate again, participate in the file-mutation queue, and rename atomically.
- Reset restores the complete default configuration.
- Closing without saving restores the loaded config and preview.

### Editor

- The editor has no tabs, presets, shrink/hide concepts, file row, Selected section, or discard action.
- Every row/alignment cell has an on-demand add selector.
- The selector uses bounded native selection behavior and remains navigable with large contributor lists.
- Chips can be moved, realigned, removed, and added at 40, 80, and 120 columns.
- Live preview appears below rows and above the two shortcut lines.
- Icons, enablement, preview width, reset, save, and close remain directly available.

### Diagnostics

- Inspect reports content, source, health, placement, consumption, and layout outcome.
- Doctor reports ownership, protocol instance, config path/error, duplicate placements, and bounded errors.
- Repeated protocol failures notify once per class and runtime.
- Diagnostics sanitize identifiers and never expose rejected payloads or credentials.

### Usage boundary

- The footer host imports no provider credentials, adapters, HTTP, or quota logic.
- Usage works alone through native status fallback.
- Usage publishes active and detail rich widgets when a host is ready.
- A live rich widget consumes the fallback without suppressing explicit native placement.
- Usage cleans up ready listeners, timers, rich widgets, and native status at shutdown.

## Validation

Before cutover:

```bash
vp test --project unit pi/extensions/footer
vp test --project integration pi/extensions/footer
vp test --project smoke pi/extensions/footer
vp check pi/extensions/footer
vp run ready
```

Cutover also requires:

- Footer and usage package documentation follows repository README policy.
- Direct loading and footer/usage co-installation smoke tests pass.
- No existing package imports from a parallel footer implementation.
- The user explicitly approves deleting the old implementation and renaming the directory.
