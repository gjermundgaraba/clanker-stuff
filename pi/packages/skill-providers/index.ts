import type { EventBus, ExtensionContext, ParsedSkillBlock } from "@earendil-works/pi-coding-agent";

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

/** The parts of a Pi skill block: its tag attributes and what `/skill:name` writes between the tags. */
export type LoadedSkill = Pick<ParsedSkillBlock, "content" | "location" | "name">;

export interface SkillProvider {
  id: string;
  /** The skills this provider serves now. */
  skills(): MentionableSkill[];
  /**
   * Load one skill after whatever approval and checks the provider requires, or explain why it
   * cannot be loaded. The name and location must be non-empty and contain no double quotes, as
   * required by Pi's skill-block attributes. Content includes any origin or relative-path guidance.
   */
  load(name: string, ctx: ExtensionContext): Promise<LoadedSkill | { error: string }>;
}

/**
 * The block Pi writes for `/skill:name`, which its chat view collapses when it leads a user message.
 * One skill reproduces its block exactly. Several share one block, each under its own heading,
 * because Pi collapses only a single leading block.
 */
export const skillBlock = (skills: readonly LoadedSkill[]): string => {
  const name = skills.map((skill) => skill.name).join(", ");
  const location = skills.map((skill) => skill.location).join(", ");

  const sections = skills.map((skill) =>
    skills.length === 1 ? skill.content : `## ${skill.name}\n\n${skill.content}`,
  );

  return `<skill name="${name}" location="${location}">\n${sections.join("\n\n")}\n</skill>`;
};

/** Decode results from extensions on the untyped event bus before consumers format them. */
const decodeLoadedSkill = (result: unknown): LoadedSkill | { error: string } => {
  if (typeof result === "object" && result !== null) {
    if ("error" in result) {
      if (typeof result.error === "string") return { error: result.error };
    } else if (
      "name" in result &&
      typeof result.name === "string" &&
      /^[^"]+$/u.test(result.name) &&
      "location" in result &&
      typeof result.location === "string" &&
      /^[^"]+$/u.test(result.location) &&
      "content" in result &&
      typeof result.content === "string"
    ) {
      return { content: result.content, location: result.location, name: result.name };
    }
  }

  return { error: "the provider returned invalid skill content" };
};

/** Announced providers by id, with load results checked. Announcements that are not providers are ignored. */
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
      const provider = announced as SkillProvider;

      providers.set(provider.id, {
        id: provider.id,
        skills: () => provider.skills(),
        load: async (name, ctx) => decodeLoadedSkill(await provider.load(name, ctx)),
      });
    }
  });

  return providers;
};
