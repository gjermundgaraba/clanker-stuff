import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
  createStatusIndicator,
} from "../../../tests/harness/tui.js";
import { acquireEditorHost } from "../index.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Inject an unsupported private Pi layout at the adapter import; testing host recovery must still exercise the real editor installation path.
vi.mock("../adapter.js", () => ({
  connect: () => {
    throw new Error("simulated unsupported editor layout");
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

it("keeps public editor features when Pi's private layout is unsupported", () => {
  const marking = Object.assign(createIdentityTheme(), {
    fg: (_color: string, text: string) => `<${text}>`,
  });

  const ctx = createExtensionHost(() => {}).createContext({ ui: { theme: marking } });
  // Pi invokes the factory while installing it.
  vi.mocked(ctx.ui.setEditorComponent).mockImplementationOnce((factory) => {
    factory!(createMockTui(), theme, createKeybindings());
    vi.mocked(ctx.ui.getEditorComponent).mockReturnValue(factory);
  });
  const host = acquireEditorHost(ctx)!;
  const editor = host.editor!;
  host.seedHistory(["older", "recalled"]);
  const editing = { input: vi.fn(() => true), changed() {}, submitted() {}, selection: () => [] };
  host.contribute("editing", editing);
  host.contribute("foreground", () => [{ start: 0, end: 1, foreground: "accent" }]);
  host.contribute("border", { render: (line) => line.replace("busy", "BUSY") });

  editor.setWorkingStatusIndicator(
    Object.assign(createStatusIndicator("working"), { renderInBorder: () => "busy" }),
  );
  expect(editor.document).toBeUndefined();
  expect(stripTerminalSequences(editor.render(30)[0]!)).toContain("BUSY");

  editor.handleInput("\u001B[A");
  expect(editor.getText()).toBe("recalled");
  // Decorations and the modal engine need the document adapter.
  expect(editing.input).not.toHaveBeenCalled();
  expect(stripTerminalSequences(editor.render(30)[1]!).trimEnd()).toBe("recalled");
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
    "shared-editor",
    "simulated unsupported editor layout",
  );
  // Cooperating extensions that load later join the same host without reinstalling.
  expect(acquireEditorHost(ctx)).toBe(host);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledOnce();
});
