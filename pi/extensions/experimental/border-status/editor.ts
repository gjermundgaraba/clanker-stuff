import { acquireEditorHost } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface BorderDecoration {
  render: (line: string, width: number, color: (text: string) => string) => string;
  mounted: (requestRender: () => void) => void;
}

export function installBorderEditor(
  ctx: ExtensionContext,
  decoration: BorderDecoration,
): (() => void) | undefined {
  const host = acquireEditorHost(ctx);
  if (!host) return undefined;
  const release = host.contribute("border", decoration);
  const unmount = host.onMount((editor) => decoration.mounted(() => editor.refresh()));
  return () => {
    unmount();
    release();
  };
}
