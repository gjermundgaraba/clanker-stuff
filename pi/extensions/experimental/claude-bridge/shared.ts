// State shared by every evaluation of this extension in one process. Subagent hosts
// can load the extension fresh for a child session, while the provider registered by
// the first evaluation keeps serving every session; whatever that serving instance
// must see from the others lives here.

import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";

import type { PromptCaptures } from "./prompt/capture.js";

export type MarkRebuildHook = (piSession: string | null, event: string) => void;

export interface SharedBridgeState {
  /** What pi assembled per agent, resolved by whichever instance serves the query. */
  promptCaptures: PromptCaptures | undefined;
  /** Pi session id → cwd. A host serving many sessions from one process has one
   *  process cwd, so Claude Code would otherwise load the host's project instructions. */
  sessionCwds: Map<string, string>;
  /** Summary operation signal → pi session id; pi forwards the signal to every summary call. */
  summarySessions: WeakMap<AbortSignal, string>;
  /** One per instance: a fresh instance forwards its session's history rewrites to the
   *  instance that serves provider traffic. */
  markRebuildHooks: Set<MarkRebuildHook>;
  /** The stream function of the instance that registered the provider. */
  activeStream: ((...args: never[]) => AssistantMessageEventStream) | undefined;
}

declare global {
  var __clankerStuffClaudeBridge: SharedBridgeState | undefined;
}

export function shared(): SharedBridgeState {
  globalThis.__clankerStuffClaudeBridge ??= {
    promptCaptures: undefined,
    sessionCwds: new Map(),
    summarySessions: new WeakMap(),
    markRebuildHooks: new Set(),
    activeStream: undefined,
  };

  return globalThis.__clankerStuffClaudeBridge;
}
