import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createTimer } from "./timer.js";

export default function timerExtension(pi: ExtensionAPI): void {
  const timer = createTimer();

  pi.on("agent_start", (_event, ctx) => {
    timer.start(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    timer.stop(ctx);
  });
  pi.on("session_shutdown", () => {
    timer.dispose();
  });
}
