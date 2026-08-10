import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionCommandContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import type { SettingItem } from "@earendil-works/pi-tui";

export const showToolsPicker = async (
  ctx: ExtensionCommandContext,
  tools: ToolInfo[],
  activeTools: Set<string>,
  onToggle: (toolName: string, enabled: boolean) => void
): Promise<void> => {
  await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = tools.map((tool) => ({
      currentValue: activeTools.has(tool.name) ? "enabled" : "disabled",
      id: tool.name,
      label: tool.name,
      values: ["enabled", "disabled"],
    }));
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Tool Configuration")), 0, 1)
    );
    const settings = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        onToggle(id, value === "enabled");
      },
      () => {
        done(null);
      }
    );
    container.addChild(settings);

    return {
      handleInput(data: string) {
        settings.handleInput(data);
        tui.requestRender();
      },
      invalidate() {
        container.invalidate();
      },
      render(width: number) {
        return container.render(width);
      },
    };
  });
};
