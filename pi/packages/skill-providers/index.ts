import type {
  EventBus,
  ExtensionContext,
  ParsedSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

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
export type LoadedSkill = Pick<
  ParsedSkillBlock,
  "content" | "location" | "name"
>;

/** A skill's block parts besides its name, which stays the name it was requested by. */
export type ProvidedSkill = Omit<LoadedSkill, "name">;

export interface SkillProvider {
  id: string;
  /** The skills this provider serves now. */
  skills(): MentionableSkill[];
  /**
   * Load one skill after whatever approval and checks the provider requires, or explain why it
   * cannot be loaded. Content includes any origin or relative-path guidance.
   */
  load(
    name: string,
    ctx: ExtensionContext
  ): Promise<ProvidedSkill | { error: string }>;
}

/** Skill-block attribute values. Pi's parser reads each up to the next double quote. */
const attribute = (values: readonly string[]): string =>
  values.join(", ").replaceAll('"', "%22");

/**
 * The block Pi writes for `/skill:name`, which its chat view collapses when it leads a user message.
 * One skill reproduces its block exactly. Several share one block, each under its own heading,
 * because Pi collapses only a single leading block.
 */
export const skillBlock = (skills: readonly LoadedSkill[]): string => {
  const name = attribute(skills.map((skill) => skill.name));
  const location = attribute(skills.map((skill) => skill.location));

  const sections = skills.map((skill) =>
    skills.length === 1 ? skill.content : `## ${skill.name}\n\n${skill.content}`
  );

  return `<skill name="${name}" location="${location}">\n${sections.join("\n\n")}\n</skill>`;
};

const LoadErrorSchema = Type.Object({ error: Type.String() });

/** Pi's skill blocks need a location. */
const ProvidedSkillSchema = Type.Object({
  content: Type.String(),
  location: Type.String({ minLength: 1 }),
});

const MentionableSkillsSchema = Type.Array(
  Type.Object({ name: Type.String(), description: Type.String() })
);

/** Decode results from extensions on the untyped event bus before consumers format them. */
const decodeProvidedSkill = (
  result: unknown
): ProvidedSkill | { error: string } => {
  if (Value.Check(LoadErrorSchema, result)) {
    return { error: result.error };
  }

  // A result that reports an error, even malformed, loads nothing.
  if (Value.Check(ProvidedSkillSchema, result) && !("error" in result)) {
    return { content: result.content, location: result.location };
  }

  return { error: "the provider returned invalid skill content" };
};

/** Announced providers by id, with load results checked. Announcements that are not providers are ignored. */
export const collectSkillProviders = (
  events: EventBus
): Map<string, SkillProvider> => {
  const providers = new Map<string, SkillProvider>();

  events.on(SKILL_PROVIDER_CHANNEL, (announced) => {
    if (
      typeof announced !== "object" ||
      announced === null ||
      !("id" in announced) ||
      typeof announced.id !== "string" ||
      !("skills" in announced) ||
      typeof announced.skills !== "function" ||
      !("load" in announced) ||
      typeof announced.load !== "function"
    ) {
      return;
    }

    const { id, skills, load } = announced;

    // Called on the announcement, so a provider's methods keep their `this`; what they return is
    // decoded here, since the bus carries untyped values.
    providers.set(id, {
      id,
      skills: () => {
        const listed: unknown = skills.call(announced);

        return Value.Check(MentionableSkillsSchema, listed) ? listed : [];
      },
      load: async (name, ctx) => {
        const loaded: unknown = await load.call(announced, name, ctx);

        return decodeProvidedSkill(loaded);
      },
    });
  });

  return providers;
};
