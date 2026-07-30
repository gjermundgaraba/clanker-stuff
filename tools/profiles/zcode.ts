import { claudeCodeProfile } from "./claude-code.js";
import type { HarnessProfile } from "./types.js";

const ZCODE_MODEL_IDS = new Set([
  "glm-5.2",
  "glm-5p2",
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/routers/glm-5p2-fast",
  "zai-org/GLM-5.2",
]);

export const zcodeProfile: HarnessProfile = {
  createTools: claudeCodeProfile.createTools,
  id: "zcode-native",
  matches: (model) => ZCODE_MODEL_IDS.has(model.id),
};
