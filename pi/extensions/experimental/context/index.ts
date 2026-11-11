import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createContextInspector } from "./runtime.js";

export default function contextExtension(pi: ExtensionAPI): void {
  const inspector = createContextInspector(pi);
  pi.registerCommand("context", {
    description:
      "Inspect Pi context state, observed input and request, or registered tools",
    handler: async (_args, ctx) => {
      await inspector.open(ctx);
    },
  });
  pi.on("session_start", () => {
    inspector.reset();
  });
  pi.on("context_with_system", (event, ctx) => {
    inspector.observeInput(event, ctx);
  });
  pi.on("before_provider_request", (event, ctx) => {
    inspector.observeRequest(event, ctx);
  });
  pi.on("session_tree", () => {
    inspector.reset();
  });
}
