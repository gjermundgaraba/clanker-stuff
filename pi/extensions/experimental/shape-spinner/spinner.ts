import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { defaultConfig, loadConfig, saveConfig, styleFor } from "./config.js";
import { openSettings } from "./settings.js";

export function createSpinner() {
  let config = defaultConfig();

  // Pi has no theme-change event, so a light/dark switch shows from the next run.
  const apply = (ctx: ExtensionContext): void => {
    if (ctx.mode === "tui") ctx.ui.setWorkingIndicator(styleFor(config, ctx.ui.theme.appearance));
  };

  const start = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;

    config = await loadConfig();
    apply(ctx);
  };

  const command = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;

    let changed = false;

    await openSettings(ctx, config, () => {
      changed = true;
      apply(ctx);
    });

    if (changed) await saveConfig(config);
  };

  return { apply, command, start };
}
