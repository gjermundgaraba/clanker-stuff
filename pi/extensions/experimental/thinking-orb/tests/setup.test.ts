import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundledShaderPath, installOrbShader } from "../setup.js";

describe("thinking-orb shader setup", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "thinking-orb-setup-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  const install = (confirm: () => Promise<boolean> = async () => true) =>
    installOrbShader({ configDir, confirm: (_title, _body) => confirm() });

  it("copies the bundled shader and appends the settings on confirmation", async () => {
    const result = await install();
    expect(result.shaderUpdated).toBeTruthy();
    expect(result.appendedConfigLines).toBeTruthy();
    expect(result.declined).toBeFalsy();

    const shader = await readFile(result.shaderPath, "utf-8");
    expect(shader).toBe(await readFile(bundledShaderPath(), "utf-8"));
  });

  it("appends the marker, shader path, and animation flag", async () => {
    const result = await install();
    const config = await readFile(result.configPath, "utf-8");
    expect(config).toContain(`custom-shader = ${result.shaderPath}`);
    expect(config).toContain("custom-shader-animation = false");
    expect(config).toContain("# Added by @clanker-stuff/thinking-orb");
  });

  it("is idempotent on a second run", async () => {
    await install();
    const second = await install();

    expect(second.shaderUpdated).toBeFalsy();
    expect(second.appendedConfigLines).toBeFalsy();
    expect(second.configUpdated).toBeFalsy();

    const config = await readFile(second.configPath, "utf-8");
    expect(config.match(/custom-shader =/gu)).toHaveLength(1);
  });

  it("leaves the config untouched when declined", async () => {
    const result = await install(async () => false);

    expect(result.declined).toBeTruthy();
    const config = await readFile(result.configPath, "utf-8").catch(() => "");
    expect(config).toBe("");
  });

  it("appends only missing settings to an existing config", async () => {
    const configPath = path.join(configDir, "config");
    await writeFile(
      configPath,
      "font-size = 14\ncustom-shader = /elsewhere/other.glsl\n",
      "utf-8"
    );

    const result = await install();
    const config = await readFile(configPath, "utf-8");
    expect(config).toContain("font-size = 14");
    expect(config).toContain("/elsewhere/other.glsl");
    expect(config).toContain("custom-shader-animation = false");
    expect(config).not.toContain(`custom-shader = ${result.shaderPath}`);
  });
});
