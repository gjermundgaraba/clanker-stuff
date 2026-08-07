import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { auditLocalOrder } from "../audit-local-order.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

describe("local order audit", () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { force: true, recursive: true });
      tempRoot = undefined;
    }
  });

  it("keeps the global target last after project top-level and package entries", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-order-audit-"));
    const agentDir = path.join(tempRoot, "agent");
    const cwd = path.join(tempRoot, "project");
    const projectConfig = path.join(cwd, ".pi");
    const projectPackage = path.join(cwd, "project-package");
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(projectConfig, { recursive: true }),
      mkdir(projectPackage, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(agentDir, "settings.json"),
        `${JSON.stringify({ packages: [PACKAGE_ROOT] }, null, 2)}\n`
      ),
      writeFile(
        path.join(projectConfig, "settings.json"),
        `${JSON.stringify(
          {
            extensions: ["./configured.ts"],
            packages: ["../project-package"],
          },
          null,
          2
        )}\n`
      ),
      writeFile(
        path.join(projectConfig, "configured.ts"),
        "export default () => {};\n"
      ),
      writeFile(
        path.join(projectPackage, "package.json"),
        `${JSON.stringify(
          {
            name: "project-order-fixture",
            pi: { extensions: ["./index.ts"] },
            type: "module",
          },
          null,
          2
        )}\n`
      ),
      writeFile(
        path.join(projectPackage, "index.ts"),
        "export default () => {};\n"
      ),
    ]);

    const result = await auditLocalOrder({
      agentDir,
      cwd,
      piVersion: "0.84.0",
    });
    expect({
      count: result.count,
      finalPath: result.finalPath,
      orderedFiles: result.extensions.map(({ path: extensionPath }) =>
        path.basename(extensionPath)
      ),
      piVersion: result.piVersion,
      sdkVersion: result.sdkVersion,
    }).toStrictEqual({
      count: 3,
      finalPath: path.join(PACKAGE_ROOT, "index.ts"),
      orderedFiles: ["configured.ts", "index.ts", "index.ts"],
      piVersion: "0.84.0",
      sdkVersion: "0.84.0",
    });

    await expect(
      auditLocalOrder({ agentDir, cwd, piVersion: "0.83.0" })
    ).rejects.toThrow("Unsupported Pi executable version 0.83.0");
  });
});
