import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCodexProvider } from "./registration.js";
import { registerCodexTools } from "./tools/register.js";

export default function codexProviderExtension(
  pi: ExtensionAPI,
  evaluationToolMode?: "direct" | "code_mode_only",
): void {
  registerCodexProvider(pi, (setCodeMode, settings, catalog) =>
    registerCodexTools(pi, catalog, {
      setFooterActive: setCodeMode,
      executionSettings: settings,
      ...(evaluationToolMode === undefined ? {} : { evaluationToolMode }),
    }),
  );
}
