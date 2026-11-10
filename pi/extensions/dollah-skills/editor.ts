import { acquireEditorHost } from "@clanker-stuff/editor";
import { skillMentions } from "@clanker-stuff/pi-skill-providers";
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

    return skillMentions(text)
      .filter((mention) => names.has(mention.name))
      .map(({ start, end }) => ({ start, end }));
  });
};
