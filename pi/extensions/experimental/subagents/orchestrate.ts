import { fileURLToPath } from "node:url";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Protocol } from "./selection.js";

export const ORCHESTRATE_SKILL_PATH = fileURLToPath(
  new URL("vendor/orchestrate/SKILL.md", import.meta.url),
);

export const discoverOrchestrateSkill = (
  ctx: Pick<ExtensionContext, "model">,
  protocol: Protocol | undefined,
): { skillPaths: string[] } | undefined =>
  ctx.model?.provider === "openai-codex" && (protocol === "v1" || protocol === "v2")
    ? { skillPaths: [ORCHESTRATE_SKILL_PATH] }
    : undefined;
