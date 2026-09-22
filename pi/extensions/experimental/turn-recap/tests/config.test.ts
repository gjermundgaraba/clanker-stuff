import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { loadRecapConfig, parseRecapConfig } from "../config.js";

const temporaryConfigPath = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recap-config-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));

  return path.join(directory, "turn-recap.json");
};

describe("recap config", () => {
  it("parses and trims an explicit model", () => {
    expect(
      parseRecapConfig({
        model: { id: " small ", provider: " cheap " },
      }),
    ).toStrictEqual({
      model: { id: "small", provider: "cheap" },
      thinking: "off",
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

  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
    "accepts explicit %s thinking",
    (thinking) => {
      expect(
        parseRecapConfig({ model: { id: " small ", provider: " cheap " }, thinking }),
      ).toStrictEqual({ model: { id: "small", provider: "cheap" }, thinking });
    },
  );

  it.each(["", "auto", "HIGH", " low ", null, true, 2, {}])(
    "rejects invalid thinking %j",
    (thinking) => {
      expect(() =>
        parseRecapConfig({ model: { id: "small", provider: "cheap" }, thinking }),
      ).toThrow("optional thinking");
    },
  );

  it("loads the strict JSON file", async () => {
    const configPath = await temporaryConfigPath();
    await writeFile(
      configPath,
      JSON.stringify({ model: { id: "small", provider: "cheap" }, thinking: "low" }),
      "utf-8",
    );

    await expect(loadRecapConfig(configPath)).resolves.toStrictEqual({
      model: { id: "small", provider: "cheap" },
      thinking: "low",
    });
  });

  it("preserves file and JSON errors", async () => {
    const configPath = await temporaryConfigPath();
    await expect(loadRecapConfig(configPath)).resolves.toBeUndefined();

    await writeFile(configPath, "{", "utf-8");
    await expect(loadRecapConfig(configPath)).rejects.toBeInstanceOf(SyntaxError);
  });
});
