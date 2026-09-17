import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createVim } from "./lifecycle.js";

export default function vim(pi: ExtensionAPI) {
  const runtime = createVim(pi);
  pi.on("session_start", (_event, ctx) => runtime.start(ctx));
  pi.on("session_tree", (event, ctx) => runtime.navigate(ctx, event.newLeafId));
  pi.on("session_shutdown", () => runtime.dispose());
}
