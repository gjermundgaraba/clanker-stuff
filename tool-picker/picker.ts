import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionCommandContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import type { SettingItem } from "@earendil-works/pi-tui";

export const showToolsConfigurationUI = async (
  ctx: ExtensionCommandContext,
  allTools: ToolInfo[],
  enabledTools: Set<string>,
  onToggle: (toolName: string, enabled: boolean) => void
): Promise<void> => {
  await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = allTools.map((tool) => ({
      currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
      id: tool.name,
      label: tool.name,
      values: ["enabled", "disabled"],
    }));

    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Tool Configuration")), 0, 1)
    );

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => onToggle(id, newValue === "enabled"),
      () => done(null)
    );

    container.addChild(settingsList);

    return {
      handleInput(data: string) {
        settingsList.handleInput(data);
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
