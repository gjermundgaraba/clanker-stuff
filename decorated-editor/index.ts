import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { REGISTER_DECORATION_EVENT, createDecoratedEditor } from "./editor.js";

export default function decoratedEditorExtension(pi: ExtensionAPI): void {
  const editor = createDecoratedEditor();

  pi.events.on(REGISTER_DECORATION_EVENT, (data) => {
    editor.register(data);
  });
  pi.on("session_start", (_event, ctx) => {
    editor.install(ctx);
  });
}
