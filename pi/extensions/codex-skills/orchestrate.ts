import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CONTRACT_REQUEST = "clanker-stuff:subagents:contract:request";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const ORCHESTRATE_SKILL_PATH = fileURLToPath(
  new URL("vendor/orchestrate/SKILL.md", import.meta.url)
);

export const discoverOrchestrateSkill = (
  pi: ExtensionAPI,
  ctx: ExtensionContext
): { skillPaths: string[] } | undefined => {
  if (ctx.model?.provider !== "openai-codex") {
    return undefined;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  let hasCollaboration = false;
  pi.events.emit(CONTRACT_REQUEST, {
    context: ctx,
    provide(value: unknown) {
      if (
        isRecord(value) &&
        value.version === 1 &&
        value.sessionId === sessionId &&
        (value.protocol === "v1" || value.protocol === "v2") &&
        Array.isArray(value.nestedTools)
      ) {
        hasCollaboration = true;
      }
    },
    sessionId,
  });

  return hasCollaboration
    ? { skillPaths: [ORCHESTRATE_SKILL_PATH] }
    : undefined;
};
