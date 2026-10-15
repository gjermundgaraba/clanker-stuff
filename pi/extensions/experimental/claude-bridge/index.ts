import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Bridge } from "./bridge.js";
import { BridgeLifecycle, forwardRewrite } from "./provider.js";
import { rememberSummarySession } from "./session/cwd.js";

export default function claudeBridge(pi: ExtensionAPI): void {
  const bridge = new Bridge();
  const lifecycle = new BridgeLifecycle(pi, bridge);

  // The `claude-bridge` provider: Claude Code models served through the Agent SDK.
  // Registered through the lifecycle rather than with a direct pi.registerProvider()
  // because only the first evaluation in a process registers at load; later ones decide
  // at session_start (see provider.ts).
  lifecycle.registerProvider();

  pi.on("session_start", (event, ctx) => {
    lifecycle.sessionStart(event, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    lifecycle.sessionShutdown(ctx);
  });

  // Summary calls run in the session's cwd; pi forwards the operation's signal to them.
  pi.on("session_before_compact", (event, ctx) => {
    rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
  });
  pi.on("session_before_tree", (event, ctx) => {
    rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
  });

  // History rewrites: the compacting or navigating session's Claude Code conversation
  // must be rebuilt, and a query parked on it discarded.
  pi.on("session_compact", (event, ctx) => {
    forwardRewrite(
      ctx.sessionManager.getSessionId(),
      `session_compact:${event.reason}:willRetry=${event.willRetry}`,
    );
  });
  pi.on("session_tree", (_event, ctx) => {
    forwardRewrite(ctx.sessionManager.getSessionId(), "session_tree");
  });
}
