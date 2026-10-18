import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Channel on `pi.events` where extensions announce skills that do not live on disk, such as skills
 * MCP servers serve. Announce on every `session_start`; a later announcement with the same `id`
 * replaces the earlier one.
 */
export const SKILL_PROVIDER_CHANNEL = "skill-providers:provider";

export interface MentionableSkill {
  /** The name a `$` mention uses. Must not collide with a skill on disk. */
  name: string;
  description: string;
}

export interface SkillProvider {
  id: string;
  /** The skills this provider serves now. */
  skills(): MentionableSkill[];
  /**
   * Load one skill as a Pi skill block (`<skill name="…" location="…">…</skill>`), after whatever
   * approval and checks the provider requires, or explain why it cannot be loaded.
   */
  load(name: string, ctx: ExtensionContext): Promise<{ block: string } | { error: string }>;
}

/** Announced providers by id. Announcements that are not providers are ignored. */
export const collectSkillProviders = (events: EventBus): Map<string, SkillProvider> => {
  const providers = new Map<string, SkillProvider>();

  events.on(SKILL_PROVIDER_CHANNEL, (announced) => {
    if (
      typeof announced === "object" &&
      announced !== null &&
      "id" in announced &&
      typeof announced.id === "string" &&
      "skills" in announced &&
      typeof announced.skills === "function" &&
      "load" in announced &&
      typeof announced.load === "function"
    ) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi.events carries untyped payloads; the members this module calls were checked above, and their signatures are this channel's documented contract.
      providers.set(announced.id, announced as SkillProvider);
    }
  });

  return providers;
};
