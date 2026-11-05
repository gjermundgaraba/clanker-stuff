import { acquireEditorHost } from "@clanker-stuff/editor";
import { SKILL_MENTION } from "@clanker-stuff/pi-skill-providers";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const installSkillMentionEditor = (
  ctx: ExtensionContext,
  getSkillNames: () => string[]
) => {
  const host = acquireEditorHost(ctx);

  if (!host) {
    return;
  }

  host.contribute("highlight", (text) => {
    const names = new Set(getSkillNames());

    return text
      .matchAll(SKILL_MENTION)
      .filter((match) => names.has(match[0].slice(1)))
      .map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      }))
      .toArray();
  });
};
