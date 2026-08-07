import { claudeCodeProfile } from "./claude-code.js";
import { codexProfile } from "./codex.js";
import { grokBuildProfile } from "./grok-build.js";
import { kimiCodeProfile } from "./kimi-code.js";
import type { HarnessProfile } from "./types.js";
import { zcodeProfile } from "./zcode.js";

export const HARNESS_PROFILES: readonly HarnessProfile[] = [
  codexProfile,
  claudeCodeProfile,
  grokBuildProfile,
  zcodeProfile,
  kimiCodeProfile,
];
