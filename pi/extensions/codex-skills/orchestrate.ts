import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const CONTRACT_REQUEST = "clanker-stuff:subagents:contract:request";

const CollaborationContractSchema = Type.Object({
  nestedTools: Type.Array(Type.Unknown()),
  protocol: Type.Union([Type.Literal("off"), Type.Literal("v1"), Type.Literal("v2")]),
  sessionId: Type.String(),
  version: Type.Literal(1),
});
type CollaborationContract = Static<typeof CollaborationContractSchema>;
type OrchestrateApi = { events: Pick<ExtensionAPI["events"], "emit"> };
interface OrchestrateContext {
  readonly model?: { readonly provider: string } | null;
  readonly sessionManager: { getSessionId(): string };
}

export const ORCHESTRATE_SKILL_PATH = fileURLToPath(
  new URL("vendor/orchestrate/SKILL.md", import.meta.url),
);

export const discoverOrchestrateSkill = (
  pi: OrchestrateApi,
  ctx: OrchestrateContext,
): { skillPaths: string[] } | undefined => {
  if (ctx.model?.provider !== "openai-codex") {
    return undefined;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  let hasCollaboration = false;
  pi.events.emit(CONTRACT_REQUEST, {
    context: ctx,
    provide(value: CollaborationContract) {
      if (
        Value.Check(CollaborationContractSchema, value) &&
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

  return hasCollaboration ? { skillPaths: [ORCHESTRATE_SKILL_PATH] } : undefined;
};
