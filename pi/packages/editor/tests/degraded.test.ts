import { expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createKeybindings, createMockTui } from "../../../tests/harness/tui.js";
import { acquireEditorHost } from "../index.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Inject an unsupported private Pi layout at the adapter import; testing host recovery must still exercise the real editor installation path.
vi.mock("../adapter.js", () => ({
  connect: () => {
    throw new Error("The shared editor requires Pi 0.86.1 Editor internals");
  },
}));

const identity = (s: string) => s;

const theme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

it("keeps a stock prompt and skips shared features on an unsupported Pi", () => {
  const ctx = createExtensionHost(() => {}).createContext();
  // Pi invokes the factory while installing it, after clearing its editor container.
  vi.mocked(ctx.ui.setEditorComponent).mockImplementationOnce((factory) => {
    const editor = factory!(createMockTui(), theme, createKeybindings());
    editor.handleInput?.("still usable");
    expect(editor.getText()).toBe("still usable");
    vi.mocked(ctx.ui.getEditorComponent).mockReturnValue(factory);
  });
  expect(acquireEditorHost(ctx)).toBeUndefined();
  // Cooperating extensions that load later take the same path without reinstalling.
  expect(acquireEditorHost(ctx)).toBeUndefined();
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledOnce();
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
    "shared-editor",
    "The shared editor requires Pi 0.86.1 Editor internals",
  );
});
