import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { parseRecapEntry, RECAP_ENTRY_TYPE } from "../entry.js";
import extension from "../index.js";
import { completionMock, createRecapConfigFile, sessionWithTurns } from "./fixtures.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";

const terminalControls = Array.from({ length: 0xa0 }, (_, code) =>
  code === 0x0a || (code >= 0x20 && code < 0x7f) ? "" : String.fromCharCode(code),
).join("");
const bidiControls = "\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
const data = parseRecapEntry({
  completedTurns: 3,
  recap: `Finished the parser.\u001B[31m${terminalControls}${bidiControls}\u001B[0m\nNext: test it.`,
});

describe("recap extension", () => {
  it("registers only automatic lifecycle behavior and the recap renderer", async () => {
    const host = createExtensionHost(extension);
    await host.ready;

    expect(RECAP_ENTRY_TYPE).toBe("@clanker-stuff/recap");
    expect(host.getRegisteredCommands()).toHaveLength(0);
    expect(host.getEntryRenderer(RECAP_ENTRY_TYPE)).toBeDefined();
  });

  it("wires automatic generation and lifecycle cancellation", async () => {
    const { directory } = await createRecapConfigFile();
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const branch = sessionWithTurns(3).getBranch();
    const model = fauxProvider({
      models: [{ id: "small" }],
      provider: "cheap",
    }).getModel();
    const completion = completionMock(async (_model, _context, options) => {
      const signal = options?.signal;
      if (signal === undefined) {
        throw new Error("Expected a recap cancellation signal");
      }
      return await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve(
              fauxAssistantMessage("", {
                errorMessage: "aborted",
                stopReason: "aborted",
              }),
            );
          },
          { once: true },
        );
      });
    });
    const host = createExtensionHost(extension, {
      entries: branch,
      leafId: branch.at(-1)?.id,
    });
    const ctx = host.createContext({
      modelRegistry: {
        complete: completion,
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
    });

    await host.emitSessionStart(ctx);
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(completion.mock.calls).toHaveLength(1);

    await host.emit("agent_start", { type: "agent_start" }, ctx);
    expect(completion.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);

    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(completion.mock.calls).toHaveLength(2);

    await host.emitSessionTree(ctx);
    expect(completion.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);

    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(completion.mock.calls).toHaveLength(3);

    await host.emitSessionShutdown(ctx);
    expect(completion.mock.calls[2]?.[2]?.signal?.aborted).toBe(true);
    expect(host.getAppendedEntries()).toHaveLength(0);
  });

  it("renders valid durable recap entries", async () => {
    if (data === undefined) {
      throw new Error("Recap fixture is invalid");
    }
    const host = createExtensionHost(extension);
    await host.ready;
    const renderer = host.getEntryRenderer(RECAP_ENTRY_TYPE);
    const ctx = host.createContext();
    const entry: CustomEntry = {
      customType: RECAP_ENTRY_TYPE,
      data,
      id: "recap-1",
      parentId: "assistant-3",
      timestamp: new Date().toISOString(),
      type: "custom",
    };

    const component = renderer?.(entry, { expanded: false }, ctx.ui.theme);
    const width = 24;
    const lines = component?.render(width) ?? [];
    expect(stripTerminalSequences(lines[0] ?? "")).toBe(
      `─ Conversation recap ${"─".repeat(width - "─ Conversation recap ".length)}`,
    );
    expect(lines.slice(2)).toEqual(["  Finished the parser.", "  Next: test it."]);
    expect(stripTerminalSequences(lines.join("\n"))).not.toMatch(
      // oxlint-disable-next-line eslint/no-control-regex -- Rendered recaps must not contain terminal controls.
      /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u,
    );
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
