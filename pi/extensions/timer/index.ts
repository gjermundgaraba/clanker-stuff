import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createTimer } from "./timer.js";

export default function timerExtension(pi: ExtensionAPI): void {
  const timer = createTimer();
  pi.events.on("clanker:async-prompt", (event) =>
    timer.setAsyncPrompt(
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Event-bus boundary reads only the async-prompt activity flag; unrelated payloads must not activate the timer.
      typeof event === "object" && event !== null && "active" in event && event.active === true,
    ),
  );

  pi.on("agent_start", (_event, ctx) => {
    timer.start(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    timer.stop(ctx);
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    timer.pause(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    timer.resume(ctx);
  });
  pi.on("session_shutdown", () => {
    timer.dispose();
  });
}
