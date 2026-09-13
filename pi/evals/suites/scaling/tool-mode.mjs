import { SERVICE_NAMES } from "/opt/codex-provider/services.mjs";
import { validateToolMode as validate } from "./tool-mode-core.mjs";
export const validateToolMode = (trajectory) =>
  validate(trajectory, { directTools: SERVICE_NAMES });
