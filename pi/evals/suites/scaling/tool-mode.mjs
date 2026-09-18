import { SERVICE_NAMES } from "/opt/codex-provider/services.mjs";
import { validateToolMode as validate } from "./tool-mode-core.mjs";

/** @param {unknown} trajectory External Harbor evidence; the core verifier validates the complete arm contract. */
export const validateToolMode = (trajectory) =>
  validate(trajectory, { directTools: SERVICE_NAMES });
