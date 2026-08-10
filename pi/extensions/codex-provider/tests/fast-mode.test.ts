import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { SPIKE_MODEL } from "./fixtures.js";

const FAST_MODEL = { ...SPIKE_MODEL, id: "gpt-5.5", name: "GPT-5.5" };

describe("Codex fast mode", () => {
  let agentDir: string;
  let tempRoot: string;

  const createHost = (flags?: Record<string, boolean | string>) =>
    createExtensionHost(
      (pi) => {
        Object.assign(pi, {
          registerEntryRenderer: vi.fn<() => void>(),
          registerProvider: vi.fn<() => void>(),
        });
        extension(pi);
      },
      { flags, model: FAST_MODEL }
    );

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "codex-fast-"));
    agentDir = path.join(tempRoot, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(() => {
    rmSync(tempRoot, { force: true, recursive: true });
    vi.unstubAllEnvs();
  });

  it("persists toggles globally and hides status for unsupported models", async () => {
    const first = createHost();
    const firstContext = first.createContext();

    await first.emitSessionStart(firstContext);
    await first.runCommand("fast", "", firstContext);
    expect({
      config: JSON.parse(
        readFileSync(path.join(agentDir, "codex-provider.json"), "utf-8")
      ),
      status: first.getStatus("codex-fast"),
    }).toStrictEqual({ config: { fast: true }, status: "⚡" });

    await first.emit(
      "model_select",
      {
        model: SPIKE_MODEL,
        previousModel: FAST_MODEL,
        source: "set",
        type: "model_select",
      },
      first.createContext({ model: SPIKE_MODEL })
    );
    expect(first.getStatus("codex-fast")).toBeUndefined();

    const second = createHost();
    const secondContext = second.createContext();
    await second.emitSessionStart(secondContext);
    expect(second.getStatus("codex-fast")).toBe("⚡");

    await second.runCommand("fast", "", secondContext);
    expect({
      config: JSON.parse(
        readFileSync(path.join(agentDir, "codex-provider.json"), "utf-8")
      ),
      status: second.getStatus("codex-fast"),
    }).toStrictEqual({
      config: { fast: false },
      status: undefined,
    });
  });

  it("uses --fast only for the initial session", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "codex-provider.json"),
      '{ "fast": false }\n'
    );
    const host = createHost({ fast: true });
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    expect(host.getStatus("codex-fast")).toBe("⚡");

    await host.emitSessionStart(ctx, "new");
    expect(host.getStatus("codex-fast")).toBeUndefined();
  });
});
