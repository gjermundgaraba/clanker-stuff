import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSkillMentions } from "./mentions.js";

export default function dollahSkillsExtension(pi: ExtensionAPI): void {
  const mentions = createSkillMentions(pi);

  pi.on("session_start", (_event, ctx) => {
    mentions.install(ctx);
  });
  pi.on("input", async (event, ctx) => await mentions.expand(event, ctx));
}
