import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vite-plus/test";
import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import {
  createMockTui,
  createKeybindings,
  createIdentityTheme,
} from "../../../../tests/harness/tui.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import questions from "../../../ask-question/index.js";
import borderStatus from "../index.js";
import { editorTheme } from "./fixtures.js";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

it.each([true, false])(
  "real questionnaire lifecycle publishes and restores border state, host first=%s",
  async (hostFirst) => {
    const dir = await mkdtemp(path.join(tmpdir(), "border-lifecycle-"));
    let factory: EditorFactory | undefined;
    let editor: ReturnType<EditorFactory> | undefined;
    const widget = vi.fn();
    const tui = createMockTui();

    const uiHost = createExtensionHost(() => {});
    await uiHost.ready;

    const ui = uiHost.createContext({
      ui: {
        getEditorComponent: () => factory,
        getEditorText: () => editor?.getText() ?? "",
        setEditorComponent: (next: EditorFactory | undefined) => {
          factory = next;
          editor = next?.(tui, editorTheme, createKeybindings());
          editor?.render(80);
        },
        setWidget: widget,
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: createIdentityTheme(),
      },
    }).ui;

    const appender = (pi: ExtensionAPI) => {
      pi.on("session_start", () => pi.appendEntry("unrelated", {}));
      pi.on("session_tree", () => pi.appendEntry("unrelated", {}));
    };

    const harness = await createAgentSessionHarness({
      extensionFactories: hostFirst
        ? [borderStatus, appender, questions]
        : [questions, appender, borderStatus],
      mode: "tui",
      uiContext: ui,
      sessionDir: dir,
    });

    const line = () => stripTerminalSequences(editor?.render(80)[0] ?? "");

    try {
      const before = harness.sessionManager.getLeafId();
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("request_user_input_async", {
            title: "Deployment",
            questions: [
              {
                id: "target",
                header: "Target",
                question: "Where?",
                options: [{ id: "local", label: "Local" }],
              },
            ],
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Other work"),
      ]);
      await harness.prompt("Ask asynchronously");
      expect(line()).toContain("✉ 1");
      expect(widget).toHaveBeenLastCalledWith("questionnaires", [
        "1 questionnaire awaiting you · /answers",
      ]);
      const pending = harness.sessionManager.getLeafId();

      if (!pending) throw new Error("Expected persisted questionnaire branch");

      if (before) harness.sessionManager.branch(before);
      else harness.sessionManager.resetLeaf();
      await harness.session.extensionRunner.emit({
        type: "session_tree",
        newLeafId: before,
        oldLeafId: pending,
        fromExtension: false,
      });
      expect(line()).not.toContain("✉");
      harness.sessionManager.branch(pending);
      await harness.session.extensionRunner.emit({
        type: "session_tree",
        newLeafId: pending,
        oldLeafId: before,
        fromExtension: false,
      });
      expect(line()).toContain("✉ 1");
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      expect(line()).not.toContain("✉");
    } finally {
      harness.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
