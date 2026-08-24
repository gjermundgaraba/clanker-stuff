import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_WIDGET_EVENT,
} from "@clanker-stuff/footer-protocol";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createToolsModel } from "./fixtures.js";

describe("Codex footer widgets", () => {
  it("publishes rich Fast and Code Mode widgets", async () => {
    const model = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(extension, {
      flags: { fast: true },
      model,
    });
    await host.ready;
    const messages: unknown[] = [];
    host.events.on(FOOTER_WIDGET_EVENT, (value) => {
      messages.push(value);
    });
    host.events.emit(FOOTER_READY_EVENT, {
      instanceId: "footer-1",
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "ready",
    });
    const context = host.createContext({ model });

    await host.emitSessionStart(context);
    await host.runCommand("code-mode", "", context);

    expect(messages).toMatchObject([
      {
        type: "upsert",
        widget: {
          consumesStatusKeys: ["codex-fast"],
          content: [{ text: "fast", tone: "warning" }],
          icon: { glyphs: { ascii: ">>", nerd: "󱐋", unicode: "⚡" } },
          id: "clanker.codex.fast",
        },
      },
      {
        type: "upsert",
        widget: {
          consumesStatusKeys: ["codex-code-mode"],
          content: [{ text: "code", tone: "accent" }],
          icon: { glyphs: { ascii: "</>", nerd: "󰅩", unicode: "</>" } },
          id: "clanker.codex.code-mode",
        },
      },
    ]);

    await host.runCommand("code-mode", "", context);
    await host.emitSessionShutdown(context);

    expect(messages.slice(-2)).toMatchObject([
      { id: "clanker.codex.code-mode", type: "remove" },
      { id: "clanker.codex.fast", type: "remove" },
    ]);
  });
});
