import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { recordResumeCommand } from "./resume-command.js";

export default function shellResumeHistory(pi: ExtensionAPI): void {
  pi.on("session_shutdown", (event, ctx) =>
    recordResumeCommand(event.reason, ctx)
  );
}
