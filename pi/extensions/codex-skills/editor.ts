import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const installSkillMentionEditor = (
  ctx: ExtensionContext,
  skillNames: string[]
): void => {
  if (skillNames.length === 0) {
    return;
  }

  const pattern = new RegExp(
    `\\$(?:${skillNames.join("|")})(?![A-Za-z0-9_:-])`,
    "gu"
  );
  const previous = ctx.ui.getEditorComponent();
  ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
    const editor =
      previous?.(tui, editorTheme, keybindings) ??
      new CustomEditor(tui, editorTheme, keybindings);
    const render = editor.render.bind(editor);

    editor.render = (width) =>
      render(width).map((line) =>
        line.replace(pattern, (match) => ctx.ui.theme.fg("accent", match))
      );
    return editor;
  });
};
