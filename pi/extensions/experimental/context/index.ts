import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createContextInspector } from "./runtime.js";

export default function contextExtension(pi: ExtensionAPI): void {
  const inspector = createContextInspector();
  pi.registerCommand("context", {
    description: "Inspect Pi context state or the latest observed provider request",
    handler: (_args, ctx) => inspector.open(ctx),
  });
  pi.on("session_start", () => inspector.reset());
  pi.on("before_provider_request", (event, ctx) => inspector.observe(event, ctx));
  pi.on("session_tree", () => inspector.reset());
}
