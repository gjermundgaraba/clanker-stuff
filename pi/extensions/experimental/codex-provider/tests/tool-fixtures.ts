import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCodexModelCatalog } from "../model-catalog.js";
import { registerCodexTools } from "../tools/register.js";

// Tool-only tests deliberately use the curated offline catalog, not provider refresh.
export const registerFallbackCodexTools = (
  pi: ExtensionAPI,
  options?: Parameters<typeof registerCodexTools>[2],
): void => registerCodexTools(pi, createCodexModelCatalog(), options);
