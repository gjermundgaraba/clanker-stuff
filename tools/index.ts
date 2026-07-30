import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createToolsRuntime } from "./runtime.js";

export default function toolsExtension(pi: ExtensionAPI): void {
  const runtime = createToolsRuntime(pi);

  pi.on("session_start", (_event, ctx) => {
    runtime.apply(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    runtime.apply(ctx);
  });

  pi.on("session_shutdown", async () => {
    await runtime.dispose();
  });
}
