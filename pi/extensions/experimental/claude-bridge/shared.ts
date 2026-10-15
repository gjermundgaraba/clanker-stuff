// State shared by every evaluation of this extension in one process. Subagent hosts
// can load the extension fresh for a child session, and pi calls whichever evaluation's
// stream function registered last; whatever a stream must find lives here.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { Conversation } from "./conversations.js";

export interface SharedBridgeState {
  /** Pi session id → cwd. A host serving many sessions from one process has one
   *  process cwd, so Claude Code would otherwise load the host's project instructions. */
  sessionCwds: Map<string, string>;
  /** Pi session id → its Claude Code conversation. */
  conversations: Map<string, Conversation>;
  /** Pi session id → the UI its notices go to. */
  uis: Map<string, ExtensionUIContext>;
}

declare global {
  var __clankerStuffClaudeBridge: SharedBridgeState | undefined;
}

export function shared(): SharedBridgeState {
  globalThis.__clankerStuffClaudeBridge ??= {
    sessionCwds: new Map(),
    conversations: new Map(),
    uis: new Map(),
  };

  return globalThis.__clankerStuffClaudeBridge;
}
