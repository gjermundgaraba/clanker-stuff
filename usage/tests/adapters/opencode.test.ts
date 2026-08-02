import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverCodexBarBinary,
  parseCodexBarUsageJson,
  runCodexBarUsage,
} from "../../adapters/opencode.js";
import { absent } from "./helpers.js";

describe("codexbar binary discovery", () => {
  it("prefers CODEXBAR_BIN when executable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codexbar-"));
    const bin = path.join(dir, "custom-codexbar");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", "utf-8");
    await chmod(bin, 0o755);

    await expect(
      discoverCodexBarBinary({ CODEXBAR_BIN: bin, PATH: "" })
    ).resolves.toBe(bin);
  });

  it("finds codexbar on PATH", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codexbar-path-"));
    const bin = path.join(dir, "codexbar");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", "utf-8");
    await chmod(bin, 0o755);
    await expect(discoverCodexBarBinary({ PATH: dir }, [])).resolves.toBe(bin);
  });

  it("returns undefined when nothing is found", async () => {
    await expect(
      discoverCodexBarBinary(
        {
          CODEXBAR_BIN: "/definitely/missing/codexbar-bin",
          PATH: "",
        },
        []
      )
    ).resolves.toBeUndefined();
  });
});

describe("codexbar JSON parsing", () => {
  it("maps primary, secondary, and tertiary windows", () => {
    const result = parseCodexBarUsageJson(
      JSON.stringify([
        {
          ok: true,
          provider: "opencodego",
          usage: {
            primary: {
              resetsAt: "2026-07-21T14:00:00.000Z",
              usedPercent: 40,
            },
            secondary: { usedPercent: 55 },
            tertiary: { usedPercent: 10 },
          },
        },
      ]),
      "opencodego",
      1000
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: 1000,
        provider: "opencode-go",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 60,
            resetsAt: "2026-07-21T14:00:00.000Z",
          },
          { id: "7d", label: "7d", remainingPercent: 45 },
          { id: "month", label: "month", remainingPercent: 90 },
        ],
      },
    });
  });

  it("rejects non-array output", () => {
    const result = parseCodexBarUsageJson(
      JSON.stringify({
        invalid: true,
      }),
      "opencodego",
      1
    );

    expect(result.ok).toBeFalsy();
  });

  it("ignores null windows", () => {
    const result = parseCodexBarUsageJson(
      JSON.stringify([
        {
          ok: true,
          provider: "opencodego",
          usage: {
            primary: { usedPercent: 20 },
            secondary: null,
            tertiary: null,
          },
        },
      ]),
      "opencodego",
      1
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: 1,
        provider: "opencode-go",
        windows: [{ id: "5h", label: "5h", remainingPercent: 80 }],
      },
    });
  });
});

describe("codexbar usage command", () => {
  it("returns the exact missing-binary message", async () => {
    const result = await runCodexBarUsage({
      discover: absent,
      now: () => 42,
    });

    expect(result).toStrictEqual({
      error: {
        kind: "unavailable",
        message:
          "CodexBar CLI not found (install CodexBar CLI or symlink codexbar onto PATH)",
      },
      ok: false,
    });
  });

  it("parses successful CLI output", async () => {
    const result = await runCodexBarUsage({
      discover: async () => "/bin/codexbar",
      exec: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            ok: true,
            provider: "opencodego",
            usage: { primary: { usedPercent: 25 } },
          },
        ]),
      }),
      now: () => 7,
    });

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: 7,
        provider: "opencode-go",
        windows: [{ id: "5h", label: "5h", remainingPercent: 75 }],
      },
    });
  });
});
