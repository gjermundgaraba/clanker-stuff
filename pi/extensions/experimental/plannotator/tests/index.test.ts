import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const handlers = vi.hoisted(() => ({
  annotate: vi.fn<Handler>(),
  last: vi.fn<Handler>(),
  review: vi.fn<Handler>(),
}));

const runtime = vi.hoisted(() => ({
  launch: vi.fn<() => void>(),
  parseArguments: vi.fn<() => string[]>(() => []),
  shutdown: vi.fn<() => Promise<void>>(async () => await Promise.resolve()),
}));
const createRuntime = vi.hoisted(() => vi.fn<() => void>());

vi.mock(import("../command-runtime.js"), () => ({
  createCommandRuntime: () => {
    createRuntime();
    return runtime;
  },
  startPlannotatorCli: vi.fn<() => never>(),
}));
vi.mock(import("../commands/review.js"), () => ({
  createReviewHandler: () => handlers.review,
}));
vi.mock(import("../commands/annotate.js"), () => ({
  createAnnotateHandler: () => handlers.annotate,
}));
vi.mock(import("../commands/last.js"), () => ({
  createLastHandler: () => handlers.last,
}));

describe("plannotator registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the three commands and delegates to their handlers", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.runCommand("plannotator-review", "review args", ctx);
    await host.runCommand("plannotator-annotate", "annotate args", ctx);
    await host.runCommand("plannotator-last", "last args", ctx);
    await host.emitSessionShutdown(ctx);

    expect([...host.getRegisteredCommands().keys()]).toStrictEqual([
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
    ]);
    expect({
      annotate: handlers.annotate.mock.calls,
      last: handlers.last.mock.calls,
      review: handlers.review.mock.calls,
      shutdown: runtime.shutdown.mock.calls,
    }).toStrictEqual({
      annotate: [["annotate args", ctx]],
      last: [["last args", ctx]],
      review: [["review args", ctx]],
      shutdown: [[]],
    });
  });

  it("does not finish loading after shutdown", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    const command = host.runCommand("plannotator-review", "", ctx);
    await host.emitSessionShutdown(ctx);
    await command;

    expect(createRuntime).not.toHaveBeenCalled();
  });
});
