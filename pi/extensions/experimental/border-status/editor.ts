import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BorderRender } from "./layout.js";

export interface BorderDecoration {
  render: (line: string, width: number, color: (text: string) => string) => BorderRender;
  availability: (supported: boolean) => void;
  bindRender: (requestRender: () => void) => void;
}

export function installBorderEditor(
  ctx: ExtensionContext,
  decoration: BorderDecoration,
): () => void {
  const previous = ctx.ui.getEditorComponent();
  let active = true;
  const decorated = new WeakSet<CustomEditor>();
  let pending = false;
  let scheduled = false;
  let reported = false;
  let currentEditor: object | undefined;
  const report = (supported: boolean) => {
    pending = supported;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!active || pending === reported) return;
      reported = pending;
      decoration.availability(reported);
    });
  };
  ctx.ui.setEditorComponent((tui, theme, keys) => {
    const editor =
      previous?.(tui, theme, keys) ??
      new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
    if (!active) return editor;
    decoration.bindRender(() => tui.requestRender());
    const supported = editor instanceof CustomEditor;
    if (currentEditor !== editor) report(false);
    currentEditor = editor;
    if (!supported || decorated.has(editor)) return editor;
    decorated.add(editor);
    const render = editor.render.bind(editor);
    editor.render = (width) => {
      const lines = render(width);
      if (!active || currentEditor !== editor) return lines;
      if (!lines.length) {
        report(false);
        return lines;
      }
      const rendered = decoration.render(lines[0]!, width, editor.borderColor);
      // Lack of width is not evidence that an established editor became incompatible.
      if (rendered.state !== "insufficient-space") report(rendered.state !== "incompatible");
      return [rendered.line, ...lines.slice(1)];
    };
    return editor;
  });
  // Do not restore a stale factory over an extension installed after ours.
  return () => {
    active = false;
  };
}
