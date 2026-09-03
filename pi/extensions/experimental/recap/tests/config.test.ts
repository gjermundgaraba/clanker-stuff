import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { loadRecapConfig, parseRecapConfig } from "../config.js";

const temporaryConfigPath = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recap-config-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  return path.join(directory, "recap.json");
};

describe("recap config", () => {
  it("parses and trims an explicit model", () => {
    expect(
      parseRecapConfig({
        model: { id: " small ", provider: " cheap " },
      }),
    ).toStrictEqual({
      model: { id: "small", provider: "cheap" },
    });
  });

  it("rejects blank values and unknown fields", () => {
    expect(() => parseRecapConfig({ model: { id: " ", provider: "cheap" } })).toThrow(
      "must be non-empty",
    );
    expect(() =>
      parseRecapConfig({
        fallback: true,
        model: { id: "small", provider: "cheap" },
      }),
    ).toThrow("must contain only");
    expect(() =>
      parseRecapConfig({
        model: { id: "small", provider: "cheap", temperature: 0 },
      }),
    ).toThrow("must contain only");
  });

  it("loads the strict JSON file", async () => {
    const configPath = await temporaryConfigPath();
    await writeFile(
      configPath,
      JSON.stringify({ model: { id: "small", provider: "cheap" } }),
      "utf-8",
    );

    await expect(loadRecapConfig(configPath)).resolves.toStrictEqual({
      model: { id: "small", provider: "cheap" },
    });
  });

  it("preserves file and JSON errors", async () => {
    const configPath = await temporaryConfigPath();
    await expect(loadRecapConfig(configPath)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(configPath, "{", "utf-8");
    await expect(loadRecapConfig(configPath)).rejects.toBeInstanceOf(SyntaxError);
  });
});
