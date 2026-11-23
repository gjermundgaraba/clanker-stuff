import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { giveBashTimeout } from "./bash-timeout.js";
import { recordStream } from "./child.js";
import type { QueryFunction } from "./child.js";
import { bridgeProvider, catalogNotice, startSession } from "./provider.js";
import { SESSION_ENTRY } from "./session/warm.js";
import { Sessions } from "./sessions.js";

/** The extension, with the Agent SDK's query() replaceable for tests. */
export const createClaudeBridge =
  (runQuery: QueryFunction): ((pi: ExtensionAPI) => void) =>
  (pi) => {
    let boundSession: string | undefined;

    const sessions = new Sessions(runQuery, (piSessionId, record) => {
      if (piSessionId === boundSession) {
        pi.appendEntry(SESSION_ENTRY, record);
      }
    });

    const provider = bridgeProvider({
      sessions,
      piTools: () => pi.getAllTools(),
    });

    const notice = catalogNotice(provider);

    pi.registerProvider(provider);

    pi.on("session_start", (_event, ctx) => {
      boundSession = ctx.sessionManager.getSessionId();
      startSession(sessions, notice, ctx);
    });

    pi.on("tool_call", (event, ctx) => {
      giveBashTimeout(event, ctx.sessionManager.getBranch());
    });

    pi.on("session_shutdown", (_event, ctx) => {
      sessions.end(ctx.sessionManager.getSessionId());
    });
  };

export default createClaudeBridge(recordStream(query));
