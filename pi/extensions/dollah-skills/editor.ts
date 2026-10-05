import { acquireEditorHost } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A `$name` mention. Names may contain `:` but never end with it, so prose like `$review:` names `review`. */
export const SKILL_MENTION = /\$(?<name>[A-Za-z0-9_:-]*[A-Za-z0-9_-])/gu;

export function installSkillMentionEditor(ctx: ExtensionContext, getSkillNames: () => string[]) {
  const host = acquireEditorHost(ctx);

  if (!host) return;
  host.contribute("foreground", (text) => {
    const names = new Set(getSkillNames());

    return text
      .matchAll(SKILL_MENTION)
      .filter((match) => names.has(match.groups?.name ?? ""))
      .map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        foreground: "accent" as const,
      }))
      .toArray();
  });
}
