import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { recordStream } from "./child.js";
import type { QueryFunction } from "./child.js";
import { providerConfig, startSession } from "./provider.js";
import { PROVIDER_ID } from "./session/convert.js";
import { Sessions } from "./sessions.js";

/** The extension, with the Agent SDK's query() replaceable for tests. */
export const createClaudeBridge =
  (runQuery: QueryFunction): ((pi: ExtensionAPI) => void) =>
  (pi) => {
    const sessions = new Sessions(runQuery);

    const config = providerConfig({
      sessions,
      piTools: () => pi.getAllTools(),
    });

    pi.registerProvider(PROVIDER_ID, config);

    pi.on("session_start", (_event, ctx) => {
      startSession(sessions, config, ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      sessions.end(ctx.sessionManager.getSessionId());
    });
  };

export default createClaudeBridge(recordStream(query));
