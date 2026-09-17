import { describe, expect, it } from "vite-plus/test";
import { acquireEditorHost } from "@clanker-stuff/editor";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createKeybindings, createMockTui } from "../../../../tests/harness/tui.js";
import vim from "../index.js";

const identity = (s: string) => s;
const theme = {
  borderColor: identity,
  selectList: {
    description: identity,
    noMatch: identity,
    selectedPrefix: identity,
    selectedText: identity,
    scrollInfo: identity,
  },
};
describe("extension lifecycle", () => {
  it("mounts a modal contribution, reports mode and detaches on shutdown", async () => {
    const fixture = createExtensionHost(vim);
    await fixture.ready;
    const ctx = fixture.createContext();
    await fixture.emitSessionStart(ctx);
    const host = acquireEditorHost(ctx)!;
    const editor = host.create(createMockTui(), theme, createKeybindings());
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("vim", "VIM INSERT");
    editor.handleInput("\x1b");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("vim", "VIM NORMAL");
    await fixture.emitSessionShutdown(ctx);
    editor.handleInput("i");
    expect(editor.getText()).toBe("i");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("vim", undefined);
  });
  it("does not install a UI in noninteractive sessions", async () => {
    const fixture = createExtensionHost(vim);
    await fixture.ready;
    const ctx = fixture.createContext({ mode: "rpc" });
    await fixture.emitSessionStart(ctx);
    expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
    await fixture.emitSessionShutdown(ctx);
  });
  it("leaves a competing editor active and reports the skipped attachment", async () => {
    const fixture = createExtensionHost(vim);
    await fixture.ready;
    const ctx = fixture.createContext();
    const foreign = () => ({
      getText: () => "draft",
      setText() {},
      handleInput() {},
      render: () => ["draft"],
      invalidate() {},
    });
    ctx.ui.setEditorComponent(foreign);
    await fixture.emitSessionStart(ctx);
    expect(ctx.ui.getEditorComponent()).toBe(foreign);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "shared-editor",
      "Custom editor: shared editing features unavailable",
    );
    await fixture.emitSessionShutdown(ctx);
  });
});
