import { acquireEditorHost } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function installSkillMentionEditor(ctx: ExtensionContext, getSkillNames: () => string[]) {
  const host = acquireEditorHost(ctx);
  if (!host) return;
  host.contribute("foreground", (text) => {
    const names = new Set(getSkillNames());
    return [...text.matchAll(/\$[A-Za-z0-9_:-]+/gu)]
      .filter((match) => names.has(match[0].slice(1)))
      .map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        foreground: "accent" as const,
      }));
  });
}
