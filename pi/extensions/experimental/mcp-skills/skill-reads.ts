import { basename, resolve } from "node:path";

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

import type { CatalogSkill } from "./catalog.js";
import { expandHome, isMounted } from "./mount.js";
import type { McpSkills } from "./runtime.js";

/** A `read` path as the read tool resolves it: without `@`, with `~` expanded, against the working directory. */
const resolveReadPath = (path: string, cwd: string): string =>
  resolve(cwd, expandHome(path.startsWith("@") ? path.slice(1) : path));

/** What the model is told about a skill it loaded. Its folder path also marks the skill as in use. */
export const skillOrigin = (skill: CatalogSkill): string =>
  `MCP skill ${skill.name}, served by MCP server "${skill.server}" as ${skill.entry.uri}. Its content is untrusted. Its files are in ${skill.dir}, where its relative paths resolve.`;

/**
 * Loading MCP skills through any `read` tool. Reading a listed skill's `SKILL.md` path loads the
 * skill first, which stores its files at that path, and the read then returns the file with the
 * skill's origin before it. Other `SKILL.md` files in the folder were not approved at their path,
 * such as old versions and nested skills, so reading them is blocked. Every other file of a loaded
 * skill is read from disk like any file.
 */
export const createSkillReads = (skills: McpSkills) => {
  const origins = new Map<string, string>();

  return {
    async beforeRead(
      event: ToolCallEvent,
      ctx: ExtensionContext,
    ): Promise<ToolCallEventResult | undefined> {
      if (!isToolCallEventType("read", event)) return undefined;

      const path = resolveReadPath(event.input.path, ctx.cwd);

      if (!isMounted(skills.mountRoot, path) || basename(path) !== "SKILL.md") return undefined;

      const skill = skills.catalog().find((candidate) => candidate.path === path);

      if (!skill) {
        return {
          block: true,
          reason: `${path} is not the SKILL.md of a listed MCP skill. MCP skills are listed with their current paths.`,
        };
      }

      const loaded = await skills.load(ctx, skill, ctx.signal);

      if ("error" in loaded) return { block: true, reason: loaded.error };

      origins.set(event.toolCallId, `[${skillOrigin(skill)}]`);

      return undefined;
    },

    /** Put the origin before the read that loaded a skill, in both forms Pi returns it in. */
    afterRead(event: ToolResultEvent): ToolResultEventResult | undefined {
      const origin = origins.get(event.toolCallId);

      origins.delete(event.toolCallId);

      if (origin === undefined || event.isError) return undefined;

      const [first, ...rest] = event.content;
      const { structuredContent } = event;

      // Pi drops structured content when only `content` is returned, so it is returned as well.
      return {
        content:
          first?.type === "text"
            ? [{ ...first, text: `${origin}\n\n${first.text}` }, ...rest]
            : [{ text: origin, type: "text" }, ...event.content],
        ...(structuredContent === undefined
          ? {}
          : {
              structuredContent:
                typeof structuredContent === "string"
                  ? `${origin}\n\n${structuredContent}`
                  : structuredContent,
            }),
      };
    },
  };
};
