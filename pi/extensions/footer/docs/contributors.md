# Footer contributor integration

Use native status integration for universal compatibility. Use the rich protocol when the footer should control semantic styling, truncation, health, icons, or placement defaults.

## Native statuses

Existing `setStatus()` extensions work without a footer dependency:

```ts
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    ctx.ui.setStatus("build", "build ready");
  });
  pi.on("session_shutdown", () => {
    context?.ui.setStatus("build", undefined);
    context = undefined;
  });
}
```

The status appears in `footer.statuses` by default and can be placed individually as `status:build`. Newlines and unsafe terminal controls are removed; safe SGR color sequences are preserved.

## Import-free event protocol

Listen for `clanker-footer:ready`, retain its fresh `instanceId`, and publish complete snapshots to `clanker-footer:widget`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const widget = {
    id: "example.build",
    label: "Build",
    content: [{ text: "build ready", tone: "success" }],
  } as const;
  let instanceId: string | undefined;

  const unsubscribe = pi.events.on("clanker-footer:ready", (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("protocol" in value) ||
      value.protocol !== 1 ||
      !("type" in value) ||
      value.type !== "ready" ||
      !("instanceId" in value) ||
      typeof value.instanceId !== "string"
    ) {
      return;
    }
    instanceId = value.instanceId;
    pi.events.emit("clanker-footer:widget", {
      protocol: 1,
      type: "upsert",
      instanceId,
      widget,
    });
  });

  pi.on("session_shutdown", () => {
    if (instanceId) {
      pi.events.emit("clanker-footer:widget", {
        protocol: 1,
        type: "remove",
        instanceId,
        id: widget.id,
      });
    }
    unsubscribe();
    instanceId = undefined;
  });
}
```

Upserts are complete replacements. Republish current snapshots after every new ready message, ignore stale instance IDs, and unregister listeners on shutdown because pi's event bus survives extension reloads.

Keep a native `build` status when the value should remain visible without this host. A valid, enabled rich widget consumes that fallback unless the user explicitly places `status:build`.

## Snapshot rules

- IDs must be lowercase dot-separated namespaces such as `example.build`, at most 128 ASCII characters; `footer.` and `status:` are reserved.
- `content` is an array of `{ text, tone?, bold? }`; supported tones are `text`, `dim`, `muted`, `accent`, `success`, `warning`, and `error`.
- Rich text is single-line and ANSI-free: controls, escape sequences, and line breaks are rejected.
- Optional `truncate` is `start`, `middle`, or `end`. Without it, left, center, and right groups truncate at the end, middle, and start respectively.
- Optional metadata includes `icon`, `defaults.enabled`, `health`, and up to 16 `consumesStatusKeys`.
- A host accepts at most 256 live rich IDs. Invalid messages keep the last valid snapshot and appear in `/footer doctor`.
