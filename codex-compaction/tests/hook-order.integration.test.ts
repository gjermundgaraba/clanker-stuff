import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRealCodexSession } from "./agent-session.js";

type RegistrationStrategy = "factory" | "resources_discover" | "session_start";
type OrderedHook =
  | "before_provider_headers"
  | "before_provider_request"
  | "context"
  | "session_before_compact";

interface HookRecord {
  hook: OrderedHook;
  label: string;
}

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const assistantResponse = () => {
  const message = {
    content: [
      {
        annotations: [],
        text: "order-probe",
        type: "output_text",
      },
    ],
    id: `msg_${crypto.randomUUID()}`,
    role: "assistant",
    status: "completed",
    type: "message",
  };
  const responseId = `resp_${crypto.randomUUID()}`;
  return new Response(
    [
      event({
        response: { id: responseId, status: "in_progress" },
        type: "response.created",
      }),
      event({
        item: {
          content: [],
          id: message.id,
          role: "assistant",
          status: "in_progress",
          type: "message",
        },
        output_index: 0,
        type: "response.output_item.added",
      }),
      event({
        content_index: 0,
        delta: "order-probe",
        output_index: 0,
        type: "response.output_text.delta",
      }),
      event({
        item: message,
        output_index: 0,
        type: "response.output_item.done",
      }),
      event({
        response: {
          id: responseId,
          output: [message],
          status: "completed",
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 12,
          },
        },
        type: "response.completed",
      }),
    ].join(""),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    }
  );
};

const orderedProbe =
  (
    label: string,
    strategy: RegistrationStrategy,
    records: HookRecord[]
  ): ExtensionFactory =>
  (pi) => {
    const register = () => {
      pi.on("context", () => {
        records.push({ hook: "context", label });
      });
      pi.on("before_provider_request", () => {
        records.push({ hook: "before_provider_request", label });
      });
      pi.on("before_provider_headers", () => {
        records.push({ hook: "before_provider_headers", label });
      });
      pi.on("session_before_compact", () => {
        records.push({ hook: "session_before_compact", label });
      });
    };
    if (strategy === "factory") {
      register();
    } else if (strategy === "session_start") {
      pi.on("session_start", register);
    } else {
      pi.on("resources_discover", register);
    }
  };

const expectTargetBeforeAdversary = (records: readonly HookRecord[]) => {
  const hooks: OrderedHook[] = [
    "context",
    "before_provider_request",
    "before_provider_headers",
    "session_before_compact",
  ];
  for (const hook of hooks) {
    const labels = records
      .filter((record) => record.hook === hook)
      .map((record) => record.label);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < labels.length; index += 2) {
      expect(labels.slice(index, index + 2)).toStrictEqual([
        "target",
        "adversary",
      ]);
    }
  }
};

const workspace = async (prefix: string) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const cwd = path.join(rootDir, "project");
  await mkdir(cwd, { recursive: true });
  return { cwd, rootDir };
};

describe("public Pi hook ordering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "factory",
    "session_start",
    "resources_discover",
  ] satisfies RegistrationStrategy[])(
    "keeps a later extension after a target using %s registration",
    async (strategy) => {
      expect.hasAssertions();
      const paths = await workspace(`codex-order-${strategy}-`);
      const records: HookRecord[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => assistantResponse())
      );
      const session = await createRealCodexSession({
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: 1000,
        },
        extensionFactories: [
          orderedProbe("target", strategy, records),
          orderedProbe("adversary", strategy, records),
        ],
        rootDir: paths.rootDir,
        sessionManager: SessionManager.inMemory(paths.cwd),
      });

      try {
        await session.prompt("hook order");
        await session.compact();
        expectTargetBeforeAdversary(records);
      } finally {
        session.dispose();
        await rm(paths.rootDir, { force: true, recursive: true });
      }
    }
  );

  it("preserves the same non-terminal order after extension reload", async () => {
    expect.hasAssertions();
    const paths = await workspace("codex-order-reload-");
    const records: HookRecord[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => assistantResponse())
    );
    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [
        orderedProbe("target", "factory", records),
        orderedProbe("adversary", "factory", records),
      ],
      rootDir: paths.rootDir,
      sessionManager: SessionManager.inMemory(paths.cwd),
    });

    try {
      await session.reload();
      records.length = 0;
      await session.prompt("hook order after reload");
      await session.compact();
      expectTargetBeforeAdversary(records);
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    "session_start",
    "resources_discover",
  ] satisfies RegistrationStrategy[])(
    "does not restore %s-deferred request hooks after reload",
    async (strategy) => {
      const paths = await workspace(`codex-order-reload-${strategy}-`);
      const records: HookRecord[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => assistantResponse())
      );
      const session = await createRealCodexSession({
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: 1000,
        },
        extensionFactories: [
          orderedProbe("target", strategy, records),
          orderedProbe("adversary", strategy, records),
        ],
        rootDir: paths.rootDir,
        sessionManager: SessionManager.inMemory(paths.cwd),
      });

      try {
        await session.reload();
        records.length = 0;
        await session.prompt("deferred hooks after reload");
        await session.compact();
        expect(records).toStrictEqual([]);
      } finally {
        session.dispose();
        await rm(paths.rootDir, { force: true, recursive: true });
      }
    }
  );

  it("uses package-list order but allows any later package to take the terminal slot", async () => {
    const paths = await workspace("codex-order-packages-");
    const packageA = path.join(paths.rootDir, "package-a");
    const packageB = path.join(paths.rootDir, "package-b");
    const localExtension = path.join(paths.rootDir, "local.ts");
    const cliExtension = path.join(paths.rootDir, "cli.ts");
    await Promise.all(
      [
        { directory: packageA, name: "a" },
        { directory: packageB, name: "b" },
      ].map(async ({ directory, name }) => {
        await mkdir(directory, { recursive: true });
        await Promise.all([
          writeFile(
            path.join(directory, "package.json"),
            JSON.stringify({
              name: `order-${name}`,
              pi: { extensions: ["index.ts"] },
              type: "module",
            })
          ),
          writeFile(
            path.join(directory, "index.ts"),
            "export default () => {};\n"
          ),
        ]);
      })
    );
    await Promise.all([
      writeFile(localExtension, "export default () => {};\n"),
      writeFile(cliExtension, "export default () => {};\n"),
    ]);
    const settings = SettingsManager.inMemory({
      extensions: [localExtension],
      packages: [packageA, packageB],
    });
    const loader = new DefaultResourceLoader({
      additionalExtensionPaths: [cliExtension],
      agentDir: paths.rootDir,
      cwd: paths.cwd,
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager: settings,
    });

    try {
      await loader.reload();
      expect(
        loader.getExtensions().extensions.map((extension) => extension.path)
      ).toStrictEqual([
        cliExtension,
        localExtension,
        path.join(packageA, "index.ts"),
        path.join(packageB, "index.ts"),
      ]);

      settings.setPackages([packageB, packageA]);
      await loader.reload();
      expect(
        loader.getExtensions().extensions.map((extension) => extension.path)
      ).toStrictEqual([
        cliExtension,
        localExtension,
        path.join(packageB, "index.ts"),
        path.join(packageA, "index.ts"),
      ]);
    } finally {
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });
});
