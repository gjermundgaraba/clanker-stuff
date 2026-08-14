import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function shellResumeHistory(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async (event, ctx) => {
    const { recordResumeCommand } = await import("./resume-command.js");
    await recordResumeCommand(event.reason, ctx);
  });
}
