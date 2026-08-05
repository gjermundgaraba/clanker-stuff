# Footer architecture and protocol

## Status

This is the normative design for `footer/`. `spec.md` contains acceptance gates, while `research.md` retains only the evidence behind the design.

## Boundaries

Pi exposes one replace-only custom-footer slot. This extension is the cooperative owner of that slot and uses only public APIs:

- `ctx.ui.setFooter()` and `ctx.ui.custom()`
- `footerData.getExtensionStatuses()` and `footerData.onBranchChange()`
- `pi.events`
- Documented session and agent events

It cannot wrap another custom footer. If another extension replaces it, the host reports `replaced` and does not fight for ownership.

Provider quota collection is outside the host. The standalone `usage` extension publishes footer data while retaining a native status fallback.

## Runtime

Each session creates a runtime containing:

- Strict global configuration.
- Immutable built-in and rich-widget snapshots.
- Current Git and session aggregates.
- A fresh protocol instance ID.
- Bounded collector and protocol errors.
- Footer ownership state.

Lifecycle states are `starting`, `active`, `disabled`, `replaced`, and `stopped`. Intentional disable or shutdown must not be mistaken for replacement. Session shutdown clears timers, subscriptions, captured context, and registry state.

The host registers its widget-event listener during extension setup. At session start it creates the runtime, installs the footer when enabled in TUI mode, then emits ready. This makes producer-first and host-first extension ordering equivalent.

## Data sources

Built-in widgets cover:

- Working directory.
- Model and thinking level.
- Context use.
- Git branch and change counts.
- Session elapsed time, tokens, cache use, and cost.

Collectors perform no work from `render()`. Git remains asynchronous. Context refreshes from current agent state at `message_end`; entry-derived session totals refresh only after persistence boundaries such as `turn_end`, because `message_end` runs before the message enters session history.

Each current native `setStatus()` entry becomes `status:<key>`. Keys containing C0/C1 controls, line breaks, or ESC are ignored. Values preserve safe SGR styling while line breaks and unsafe controls are removed.

Two reserved aggregates expand during layout:

- `footer.widgets`: live rich widgets not explicitly placed.
- `footer.statuses`: native statuses not explicitly placed or consumed.

## Rich protocol

Protocol version 1 is import-free:

```ts
const FOOTER_READY_EVENT = "clanker-footer:ready";
const FOOTER_WIDGET_EVENT = "clanker-footer:widget";
```

The host emits:

```ts
interface FooterReadyMessage {
  protocol: 1;
  type: "ready";
  instanceId: string;
}
```

Contributors emit complete replacements or removals:

```ts
type FooterWidgetMessage =
  | {
      protocol: 1;
      type: "upsert";
      instanceId: string;
      widget: FooterWidgetSnapshot;
    }
  | {
      protocol: 1;
      type: "remove";
      instanceId: string;
      id: string;
    };
```

Messages for another instance are ignored. Contributors retain their latest state, republish after every new ready message, and unregister ready listeners during shutdown because pi's event bus survives extension reloads.

### Snapshot

```ts
type FooterTone =
  "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error";

interface FooterSpan {
  text: string;
  tone?: FooterTone;
  bold?: boolean;
}

interface FooterWidgetSnapshot {
  id: string;
  label: string;
  content: readonly FooterSpan[];
  icon?:
    | false
    | {
        glyphs: string | Partial<Record<"ascii" | "unicode" | "nerd", string>>;
        tone?: FooterTone;
      };
  defaults?: { enabled?: boolean };
  health?: {
    state: "loading" | "ready" | "stale" | "error";
    message?: string;
    updatedAt?: number;
  };
  consumesStatusKeys?: readonly string[];
  truncate?: "start" | "middle" | "end";
}
```

Rich IDs are lowercase dot-separated namespaces, at most 128 ASCII characters. `footer.` and `status:` are reserved. The host accepts at most 256 live rich IDs.

Snapshots are strict objects. Limits are:

- Label: 80 Unicode code points.
- Content: 32 spans and 1,024 combined code points.
- Icon glyph: 16 code points.
- Health message: 512 code points.
- Consumed status keys: 16 entries of 128 code points each.

Rich text is single-line and ANSI-free. Structural validation uses strict TypeBox schemas; control checks, combined limits, safe copying, and stable error classes remain explicit.

Invalid messages preserve the previous valid snapshot. The host stores at most 50 sanitized error records and notifies once per error class and runtime.

## Configuration

The strict global file is:

```ts
path.join(getAgentDir(), "footer.json");
```

```ts
interface FooterConfig {
  version: 1;
  enabled: boolean;
  iconFamily: "ascii" | "unicode" | "nerd";
  separator: string;
  rows: {
    left: string[];
    center: string[];
    right: string[];
  }[];
  widgets: Record<string, { enabled?: boolean }>;
}
```

There are one to three rows. IDs and separators reject terminal controls. Unknown configured IDs remain saved so optional contributors can return later. Duplicate placements render only their first occurrence and appear in doctor output.

A missing file uses this default without creating a file:

```text
row 1 left:  footer.cwd, footer.git
row 1 right: footer.model, footer.thinking

row 2 left:  footer.context
row 2 right: clanker.usage.active

row 3 left:  footer.widgets, footer.statuses
```

The default uses Unicode icons, the `·` separator, and an enabled custom footer. Reset restores the complete default. A valid save uses the repository file-mutation queue, writes a sibling temporary file, and atomically renames it.

An invalid file remains untouched while the default renders in memory. Replacing it requires a second explicit Save.

## Editor

`/footer` opens one spatial screen with no tabs:

- Each row exposes left, center, and right cells.
- Every cell ends with `+ Add`.
- Enter grabs or drops a chip, or opens that cell's bounded selector.
- Arrows or `hjkl` navigate; Delete or Backspace removes a chip.
- Escape cancels a grab or picker, then closes without saving.
- `I`, `E`, `W`, `R`, `S`, and `Q` control icons, enablement, preview width, reset, save, and close.

The live preview sits below the rows and above help and shortcuts. Preview widths cycle through Current, 80, and 40 columns. Preview changes affect the live footer but never persist automatically; closing restores the loaded configuration.

Missing configured contributors remain warning-colored in their cells. Missing unplaced contributors appear as waiting only inside the selector.

`/footer inspect` shows widget content, source, health, placement, native consumption, and last layout decisions. `/footer doctor` shows ownership, protocol instance, config failures, duplicates, and bounded collector or protocol errors.

## Rendering

`render()` synchronously:

1. Reads the current native status map.
2. Combines native, built-in, and rich state.
3. Expands aggregates and applies enablement.
4. Renders each widget through the current theme.
5. Fits every configured row to the supplied width.

Rows never wrap. Left and right groups anchor to their edges; center remains centered when it does not collide. Widgets share constrained space through capped equal allocation. Left, center, and right content truncate at the end, middle, and start unless a producer supplies a hint.

Every returned line is clipped to the supplied visible width. Individual widget rendering failures are isolated and recorded. An unexpected top-level render failure records the error and returns no custom rows for that render.

## Icons

The user selects ASCII, Unicode, or Nerd Font manually. Missing glyphs fall back:

- Nerd Font → Unicode → ASCII → none.
- Unicode → ASCII → none.
- ASCII → none.

The host never guesses font support.

## Native fallback consumption

A rich widget may declare `consumesStatusKeys`. A matching native status is hidden from `footer.statuses` only while that rich widget is enabled, non-empty, and eligible for placement. Explicit placement of `status:<key>` always wins.

The usage companion publishes `clanker.usage.active` and `clanker.usage.details` and retains native key `usage`, so it remains useful without this host.

## Security and failure behavior

Contributed data crosses a terminal boundary even though extensions are trusted code. The host:

- Rejects controls and raw ANSI from rich data and identifiers.
- Bounds every retained collection and text field.
- Reconstructs accepted snapshots instead of retaining producer-owned objects.
- Never executes contributed callbacks, commands, or links.
- Sanitizes native status values conservatively.

The host does not retry ownership after replacement, overwrite invalid configuration implicitly, or run filesystem, network, or process work from `render()`.
