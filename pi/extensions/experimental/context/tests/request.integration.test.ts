import { contentText, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createAgentSessionHarness,
  type AgentSessionHarness,
} from "../../../../tests/harness/agent-session.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCustomUiDriver, createKeybindings } from "../../../../tests/harness/tui.js";
import extension from "../index.js";

describe("context request observation", () => {
  let harness: AgentSessionHarness | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it("observes transformed provider input/loadout separately from recorded state", async () => {
    const transform: ExtensionFactory = (pi) => {
      pi.on("context", (event) => ({
        messages: event.messages.map((message) =>
          message.role === "user" ? { ...message, content: "TRANSIENT REQUEST MESSAGE" } : message,
        ),
      }));
    };

    const state: string[] = [];
    const request: string[] = [];

    const ui = createCustomUiDriver({
      keybindings: createKeybindings({
        "tui.select.cancel": ["escape"],
        "tui.select.confirm": ["enter"],
        "tui.select.down": ["down"],
        "tui.select.pageDown": ["pageDown"],
      }),
      onComponent(component) {
        for (let row = 0; row < 4; row++) {
          state.push(component.render(120).join("\n"));
          component.handleInput?.("j");
        }

        component.handleInput?.("v");
        component.render(120);
        component.handleInput?.("j");
        component.handleInput?.("\r");

        for (let page = 0; page < 30; page++) {
          request.push(component.render(120).join("\n"));
          component.handleInput?.("\u001b[6~");
        }

        component.handleInput?.("v");
        state.push(component.render(120).join("\n"));
        component.handleInput?.("\u001b");
      },
    });

    const uiContext = createExtensionHost(() => {}).createContext({ ui: { custom: ui.custom } }).ui;
    const empty = Type.Object({}, { additionalProperties: false });

    harness = await createAgentSessionHarness({
      mode: "tui",
      uiContext,
      systemPrompt: "STATE SYSTEM PROMPT",
      settings: { defaultTools: [] },
      extensionFactories: [transform, extension],
      tools: [
        {
          name: "loadout",
          label: "Loadout",
          description: "STORED DESCRIPTION",
          parameters: empty,
          prepareLoadout: () => ({
            descriptions: { loadout: "REQUEST DESCRIPTION" },
            hiddenDeclarations: ["hidden-tool"],
          }),
          execute: async () => ({ content: [], details: undefined }),
        },
        {
          name: "hidden-tool",
          label: "Hidden tool",
          description: "Hidden from requests",
          parameters: empty,
          execute: async () => ({ content: [], details: undefined }),
        },
      ],
    });
    harness.setResponses([fauxAssistantMessage("done")]);
    await harness.prompt("ORIGINAL STORED MESSAGE");
    const entries = harness.sessionManager.getEntries();

    await harness.prompt("/context");
    // State replays the recorded declarations: loadout descriptions apply; hidden ones stay listed.
    expect(state.join("\n")).toContain("hidden-tool");
    expect(state.join("\n")).toContain("REQUEST DESCRIPTION");
    expect(state.join("\n")).not.toContain("STORED DESCRIPTION");
    expect(state.join("\n")).not.toContain("TRANSIENT REQUEST MESSAGE");
    expect(request.join("\n")).toContain("TRANSIENT REQUEST MESSAGE");
    expect(request.join("\n")).toContain("REQUEST DESCRIPTION");
    expect(request.join("\n")).not.toContain("hidden-tool");
    expect(request.join("\n")).not.toContain("STORED DESCRIPTION");
    expect(harness.sessionManager.getEntries()).toEqual(entries);
    expect(
      harness.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            contentText(entry.message.content) === "ORIGINAL STORED MESSAGE",
        ),
    ).toBe(true);
  });
});
