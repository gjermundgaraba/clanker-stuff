import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createVim } from "./lifecycle.js";

export default function vim(pi: ExtensionAPI) {
  const runtime = createVim();
  pi.on("session_start", (_event, ctx) => runtime.start(ctx));
  pi.on("session_shutdown", () => runtime.dispose());
}
