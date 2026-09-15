import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createContextInspector } from "./runtime.js";

export default function contextExtension(pi: ExtensionAPI): void {
  const inspector = createContextInspector(pi);
  pi.registerCommand("context", {
    description: "Inspect a snapshot of Pi's current context",
    handler: (_args, ctx) => inspector.open(ctx),
  });
  pi.on("session_shutdown", () => inspector.dispose());
}
