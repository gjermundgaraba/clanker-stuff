import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerRecapEntry } from "./entry.js";
import { createRecapRuntime } from "./runtime.js";

export default function recapExtension(pi: ExtensionAPI): void {
  const runtime = createRecapRuntime(pi);

  registerRecapEntry(pi);

  pi.on("session_start", (_event, ctx) => runtime.start(ctx));
  pi.on("agent_start", () => {
    runtime.cancel();
  });
  pi.on("agent_settled", (_event, ctx) => {
    runtime.settled(ctx);
  });
  pi.on("session_tree", () => {
    runtime.cancel();
  });
  pi.on("session_shutdown", () => {
    runtime.dispose();
  });
}
