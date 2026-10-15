import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { QueryFunction } from "./child.js";
import { endConversation, notifySession } from "./conversations.js";
import { providerConfig } from "./provider.js";
import { PROVIDER_ID } from "./session/convert.js";
import { forgetSessionCwd, rememberSessionCwd, rememberSummarySession } from "./session/cwd.js";
import { shared } from "./shared.js";

/** The extension, with the Agent SDK's query() replaceable for tests. */
export function createClaudeBridge(runQuery: QueryFunction): (pi: ExtensionAPI) => void {
  return (pi) => {
    // The `claude-bridge` provider: Claude Code models served through the Agent SDK.
    const config = providerConfig({
      runQuery,
      toolGuidelines: () =>
        new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []])),
    });

    pi.registerProvider(PROVIDER_ID, config);

    pi.on("session_start", (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();

      rememberSessionCwd(sessionId, ctx.cwd);
      shared().uis.set(sessionId, ctx.ui);

      if (config.models?.length === 0) {
        notifySession(
          sessionId,
          "claude-bridge: pi-ai's Anthropic catalog has no models; update @earendil-works/pi-ai",
        );
      }
    });

    pi.on("session_shutdown", (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();

      endConversation(sessionId);
      forgetSessionCwd(sessionId);
      shared().uis.delete(sessionId);
    });

    // Summary calls run in the session's cwd; pi forwards the operation's signal to them.
    pi.on("session_before_compact", (event, ctx) => {
      rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
    });
    pi.on("session_before_tree", (event, ctx) => {
      rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
    });
  };
}

export default createClaudeBridge(query);
