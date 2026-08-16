import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_WIDGET_EVENT,
} from "@clanker-stuff/footer-protocol";
import type { FooterWidgetMessage } from "@clanker-stuff/footer-protocol";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createToolsModel } from "./fixtures.js";

describe("Codex footer widgets", () => {
  it("publishes rich Fast and Code Mode widgets", async () => {
    const model = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(
      (pi) => {
        Object.assign(pi, {
          registerEntryRenderer: vi.fn<() => void>(),
          registerProvider: vi.fn<() => void>(),
        });
        extension(pi);
      },
      { flags: { fast: true }, model }
    );
    const messages: FooterWidgetMessage[] = [];
    host.events.on(FOOTER_WIDGET_EVENT, (value) => {
      messages.push(value as FooterWidgetMessage);
    });
    host.events.emit(FOOTER_READY_EVENT, {
      instanceId: "footer-1",
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "ready",
    });
    const context = host.createContext({ model });

    await host.emitSessionStart(context);
    await host.runCommand("code-mode", "", context);

    const snapshots = messages
      .filter((message) => message.type === "upsert")
      .map(({ widget }) => ({
        consumes: widget.consumesStatusKeys,
        content: widget.content,
        glyphs: widget.icon === false ? undefined : widget.icon?.glyphs,
        id: widget.id,
      }));
    expect({
      snapshots,
    }).toStrictEqual({
      snapshots: [
        {
          consumes: ["codex-fast"],
          content: [{ text: "fast", tone: "warning" }],
          glyphs: { ascii: ">>", nerd: "󱐋", unicode: "⚡" },
          id: "clanker.codex.fast",
        },
        {
          consumes: ["codex-code-mode"],
          content: [{ text: "code", tone: "accent" }],
          glyphs: { ascii: "</>", nerd: "󰅩", unicode: "</>" },
          id: "clanker.codex.code-mode",
        },
      ],
    });

    await host.runCommand("code-mode", "", context);
    await host.emitSessionShutdown(context);

    expect(
      messages
        .filter((message) => message.type === "remove")
        .map(({ id }) => id)
    ).toStrictEqual(["clanker.codex.code-mode", "clanker.codex.fast"]);
  });
});
