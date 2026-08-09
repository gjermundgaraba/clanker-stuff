import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installCopy } from "./copy.js";

export default function copyExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    installCopy(ctx);
  });
}
