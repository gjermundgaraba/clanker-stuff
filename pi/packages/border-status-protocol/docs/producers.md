# Border status producers

Depend on `@clanker-stuff/border-status-protocol`; the border-status extension itself is optional. Importing the client does not install a host.

```ts
import { createBorderStatusClient } from "@clanker-stuff/border-status-protocol";

export default function (pi) {
  const statuses = createBorderStatusClient(pi, { owner: "my-extension" });
  const publish = (ctx, navigationId = null) => {
    // Capture the session/branch identity and discard the previous branch's cache.
    statuses.attach(ctx, navigationId);
    // Restore or recompute this branch's state before publishing it.
    statuses.set("jobs", {
      icon: { nerd: "\uF0E0", unicode: "✉", ascii: "mail" },
      text: "3",
      tone: "accent",
      priority: 100,
    });
  };
  pi.on("session_start", (_event, ctx) => publish(ctx));
  pi.on("session_tree", (event, ctx) => publish(ctx, event.newLeafId));
  pi.on("session_shutdown", () => statuses.dispose());
  // When jobs change: statuses.set("jobs", ...).
  // When empty: statuses.clear("jobs").
}
```

Use one client per owner. `set` replaces an owner's keyed snapshot; `clear` removes one key; `clearAll` removes only that owner's statuses. `dispose` clears statuses and removes listeners; `attach` can reactivate the client. Async producers must cancel or reject their own stale computations after navigation, before calling `set`.

The client caches desired snapshots and republishes when a matching host becomes ready. `available` and the optional `onAvailabilityChange(available)` callback report observed host compatibility, not guaranteed visibility. Availability is established after the editor actually renders a compatible border, not merely because it inherits `CustomEditor`. Changes are coalesced and delivered outside rendering. Availability does not mean a particular status fits at the current terminal width, and replacing the editor without composing the host factory can leave it stale. Keep essential attention indicators independent of this signal.

## Payload and validation

Text is limited to 256 characters, glyph variants to 16, owner/key to 128, priorities to integers between -1000 and 1000. Raw terminal controls, line separators, and formatting controls are rejected, except that display text and glyphs may contain ZWJ (U+200D) and ZWNJ (U+200C) for emoji and text shaping. Identifiers still reject all formatting controls. Use theme tones (`text`, `muted`, `dim`, `accent`, `success`, `warning`, `error`) instead of ANSI escapes, choosing each by the meanings in the [color conventions](https://github.com/gjermundgaraba/clanker-stuff/blob/main/docs/color.md). Invalid/stale wire messages are ignored; invalid client input throws.

Missing icon variants fall back through the selected family’s supported alternatives. An explicit empty string stops fallback and intentionally omits the icon.

## Wire lifecycle

The protocol uses versioned `clanker-border-status:update`, `ready`, `ready-request`, and `unavailable` events. Readiness carries a session/branch scope and a fresh host generation ID. Updates target that generation, so delayed messages from a previous generation are ignored. Scope uses the session ID plus `null` at session start or `event.newLeafId` on tree navigation. Do not substitute `getLeafId()`: another extension may append an entry between lifecycle handlers. The event bus is cooperative, not a security boundary between extensions.
