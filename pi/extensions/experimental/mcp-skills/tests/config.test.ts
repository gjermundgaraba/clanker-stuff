import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { loadServers } from "../config.js";

const url = "https://example.com/mcp";

const withConfigs = async (
  configs: { global: unknown; project?: unknown },
  check: (dirs: { agentDir: string; cwd: string }) => void
): Promise<void> => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "mcp-skills-config-"));
  const cwd = path.join(agentDir, "project");

  try {
    await writeFile(
      path.join(agentDir, "mcp.json"),
      typeof configs.global === "string"
        ? configs.global
        : JSON.stringify(configs.global)
    );

    if (configs.project !== undefined) {
      await mkdir(path.join(cwd, CONFIG_DIR_NAME), { recursive: true });
      await writeFile(
        path.join(cwd, CONFIG_DIR_NAME, "mcp.json"),
        JSON.stringify(configs.project)
      );
    }

    check({ agentDir, cwd });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
};

describe("loadServers", () => {
  it("ignores settings skills do not use without weakening connection validation", async () => {
    await withConfigs(
      {
        global: {
          mcpServers: {
            unusedSettings: {
              url,
              oauth: "unused",
              description: 42,
              toolExposure: "not a map",
            },
            malformedOauth: {
              url,
              oauth: {
                clientId: 42,
                callbackUrl: "https://remote.example/callback",
              },
              auth: { provider: "example" },
            },
            unsafeProvider: {
              url: "http://remote.example/mcp",
              auth: { provider: "example" },
            },
            malformedHeaders: { url, headers: { Authorization: 42 } },
          },
        },
      },
      ({ agentDir, cwd }) => {
        expect(
          loadServers({ agentDir, cwd, projectTrusted: false, registered: [] })
        ).toStrictEqual([
          {
            name: "unusedSettings",
            timeoutMs: 60_000,
            transport: { kind: "http", url, headers: {} },
          },
          {
            name: "malformedOauth",
            timeoutMs: 60_000,
            transport: {
              kind: "http",
              url,
              headers: {},
              authProvider: "example",
            },
          },
        ]);
      }
    );
  });

  it("reads an mcp.json that starts with a UTF-8 BOM", async () => {
    await withConfigs(
      { global: `\uFEFF${JSON.stringify({ mcpServers: { bom: { url } } })}` },
      ({ agentDir, cwd }) => {
        expect(
          loadServers({
            agentDir,
            cwd,
            projectTrusted: false,
            registered: [],
          }).map(({ name }) => name)
        ).toStrictEqual(["bom"]);
      }
    );
  });

  it("applies a trusted project's override that also sets toolExposure", async () => {
    await withConfigs(
      {
        global: { mcpServers: { disabled: { url }, kept: { url } } },
        project: {
          mcpServers: {
            disabled: { enabled: false, toolExposure: { search: "hidden" } },
          },
        },
      },
      ({ agentDir, cwd }) => {
        expect(
          loadServers({
            agentDir,
            cwd,
            projectTrusted: true,
            registered: [],
          }).map(({ name }) => name)
        ).toStrictEqual(["kept"]);
      }
    );
  });
});
