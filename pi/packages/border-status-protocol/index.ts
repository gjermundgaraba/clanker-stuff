import { ToneSchema } from "@clanker-stuff/pi-tones";
import { GlyphMapSchema } from "@clanker-stuff/status-icons";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const BORDER_STATUS_EVENT = "clanker-border-status:update";

export const BORDER_READY_EVENT = "clanker-border-status:ready";

export const BORDER_READY_REQUEST_EVENT = "clanker-border-status:ready-request";

export const BORDER_UNAVAILABLE_EVENT = "clanker-border-status:unavailable";

const strict = { additionalProperties: false } as const;

const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]*$",
});

// Joining characters are valid display content, but remain forbidden in identifiers.
const displayText = (maxLength: number) =>
  Type.String({
    maxLength,
    pattern: "^(?:[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]|[\\u200C\\u200D])*$",
  });

export const BorderStatusSchema = Type.Object(
  {
    text: displayText(256),
    icon: Type.Optional(
      Type.Intersect([GlyphMapSchema, Type.Record(Type.String(), displayText(16))]),
    ),
    tone: Type.Optional(ToneSchema),
    priority: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
  },
  strict,
);

export type BorderStatus = Static<typeof BorderStatusSchema>;

export const BorderReadySchema = Type.Object(
  {
    version: Type.Literal(1),
    instanceId: id,
    scope: Type.String({ maxLength: 1024 }),
  },
  strict,
);

export type BorderReady = Static<typeof BorderReadySchema>;

const envelope = { ...BorderReadySchema.properties, owner: id };

export const BorderUpdateSchema = Type.Union([
  Type.Object(
    { ...envelope, type: Type.Literal("set"), key: id, status: BorderStatusSchema },
    strict,
  ),
  Type.Object({ ...envelope, type: Type.Literal("clear"), key: id }, strict),
  Type.Object({ ...envelope, type: Type.Literal("clear-owner") }, strict),
]);

export const BorderReadyRequestSchema = Type.Object({ version: Type.Literal(1) }, strict);

/** Use null on session_start and event.newLeafId on session_tree, never the mutable current leaf. */
export const borderScope = (ctx: ExtensionContext, navigationId: string | null = null): string =>
  JSON.stringify([ctx.sessionManager.getSessionId(), navigationId]);

export interface BorderClientOptions {
  owner: string;
  onAvailabilityChange?: (available: boolean) => void;
}

/** One client per producer. Attach after restoring producer state on each navigation. */
export function createBorderStatusClient(
  pi: Pick<ExtensionAPI, "events">,
  options: BorderClientOptions,
) {
  if (!Value.Check(id, options.owner)) throw new Error("Invalid border status owner");
  const desired = new Map<string, BorderStatus>();
  let scope: string | undefined;
  let ready: BorderReady | undefined;
  let unsubscribe: (() => void)[] = [];

  const available = (next: BorderReady | undefined) => {
    const changed = !!ready !== !!next;
    ready = next;

    if (changed) options.onAvailabilityChange?.(!!ready);
  };

  const publish = (key: string, status: BorderStatus) => {
    if (ready)
      pi.events.emit(BORDER_STATUS_EVENT, {
        ...ready,
        owner: options.owner,
        type: "set",
        key,
        status,
      });
  };

  const clearAll = () => {
    desired.clear();

    if (ready)
      pi.events.emit(BORDER_STATUS_EVENT, { ...ready, owner: options.owner, type: "clear-owner" });
  };

  const listen = () => {
    if (unsubscribe.length) return;
    unsubscribe = [
      pi.events.on(BORDER_READY_EVENT, (value) => {
        if (!Value.Check(BorderReadySchema, value) || value.scope !== scope) return;
        // Publish before switching consumers from their fallback UI.
        const wasAvailable = ready !== undefined;
        ready = value;

        for (const [key, status] of desired) publish(key, status);

        if (!wasAvailable) options.onAvailabilityChange?.(true);
      }),
      pi.events.on(BORDER_UNAVAILABLE_EVENT, (value) => {
        if (Value.Check(BorderReadySchema, value) && value.instanceId === ready?.instanceId)
          available(undefined);
      }),
    ];
  };

  return {
    attach(ctx: ExtensionContext, navigationId: string | null = null) {
      clearAll();
      available(undefined);
      scope = ctx.mode === "tui" ? borderScope(ctx, navigationId) : undefined;
      listen();

      if (scope !== undefined) pi.events.emit(BORDER_READY_REQUEST_EVENT, { version: 1 });
    },
    set(key: string, status: BorderStatus) {
      if (!Value.Check(id, key) || !Value.Check(BorderStatusSchema, status))
        throw new Error("Invalid border status");
      const snapshot = structuredClone(status);
      desired.set(key, snapshot);
      publish(key, snapshot);
    },
    clear(key: string) {
      if (!Value.Check(id, key)) throw new Error("Invalid border status key");
      desired.delete(key);

      if (ready)
        pi.events.emit(BORDER_STATUS_EVENT, { ...ready, owner: options.owner, type: "clear", key });
    },
    clearAll,
    get available() {
      return ready !== undefined;
    },
    dispose() {
      clearAll();
      available(undefined);
      scope = undefined;

      for (const stop of unsubscribe) stop();
      unsubscribe = [];
    },
  };
}
