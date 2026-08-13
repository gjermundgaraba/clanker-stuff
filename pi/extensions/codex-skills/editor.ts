import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const installSkillMentionEditor = (
  ctx: ExtensionContext,
  getSkillNames: () => string[]
): void => {
  const pattern = /\$[A-Za-z0-9_:-]+(?![A-Za-z0-9_:-])/gu;
  const previous = ctx.ui.getEditorComponent();
  ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
    const editor =
      previous?.(tui, editorTheme, keybindings) ??
      new CustomEditor(tui, editorTheme, keybindings);
    const render = editor.render.bind(editor);

    editor.render = (width) => {
      const skillNames = new Set(getSkillNames());
      return render(width).map((line) =>
        line.replace(pattern, (match) =>
          skillNames.has(match.slice(1))
            ? ctx.ui.theme.fg("accent", match)
            : match
        )
      );
    };
    return editor;
  });
};
