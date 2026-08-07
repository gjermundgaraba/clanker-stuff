import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSkillMentions } from "./mentions.js";
import type { InjectedSkillsDetails } from "./mentions.js";

export default function codexSkillsExtension(pi: ExtensionAPI): void {
  const mentions = createSkillMentions(pi);

  pi.registerMessageRenderer<InjectedSkillsDetails>(
    "codex-skills",
    mentions.render
  );
  pi.on("session_start", (_event, ctx) => {
    mentions.install(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => mentions.inject(event, ctx));
}
