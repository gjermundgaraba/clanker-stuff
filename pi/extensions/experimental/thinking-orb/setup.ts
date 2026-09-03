/**
 * One-time Ghostty setup: copies the bundled shader next to the Ghostty
 * configuration and, with confirmation, appends the required settings.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { ORB_SHADER_BASENAME } from "./ghostty.js";

const CONFIG_MARKER = "# Added by @clanker-stuff/thinking-orb";

export const defaultGhosttyConfigDir = (): string => {
  const xdgConfigDir =
    process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  const unixDir = path.join(xdgConfigDir, "ghostty");
  if (existsSync(unixDir)) {
    return unixDir;
  }

  const macosDir = path.join(
    homedir(),
    "Library",
    "Application Support",
    "com.mitchellh.Ghostty"
  );
  if (process.platform === "darwin" && existsSync(macosDir)) {
    return macosDir;
  }

  return unixDir;
};

export const bundledShaderPath = (): string =>
  fileURLToPath(new URL(`shaders/${ORB_SHADER_BASENAME}`, import.meta.url));

export interface ShaderSetupDeps {
  confirm: (title: string, body: string) => Promise<boolean>;
  configDir?: string;
}

export interface ShaderSetupResult {
  appendedConfigLines: boolean;
  configPath: string;
  configUpdated: boolean;
  declined: boolean;
  shaderPath: string;
  shaderUpdated: boolean;
}

const hasSetting = (configText: string, key: string): boolean =>
  new RegExp(`^\\s*${key}\\s*=`, "mu").test(configText);

export const installOrbShader = async (
  deps: ShaderSetupDeps
): Promise<ShaderSetupResult> => {
  const configDir = deps.configDir ?? defaultGhosttyConfigDir();
  const shadersDir = path.join(configDir, "shaders");
  const shaderPath = path.join(shadersDir, ORB_SHADER_BASENAME);
  const configPath = path.join(configDir, "config");

  const source = await readFile(bundledShaderPath(), "utf-8");
  let shaderUpdated = false;
  await withFileMutationQueue(shaderPath, async () => {
    await mkdir(shadersDir, { recursive: true });
    const existing = await readFile(shaderPath, "utf-8").then(
      (text) => text,
      () => null
    );
    shaderUpdated = existing !== source;
    if (shaderUpdated) {
      await writeFile(shaderPath, source, "utf-8");
    }
  });

  const configText = await readFile(configPath, "utf-8").catch(() => "");
  const missingLines = [
    hasSetting(configText, "custom-shader")
      ? undefined
      : `custom-shader = ${shaderPath}`,
    hasSetting(configText, "custom-shader-animation")
      ? undefined
      : "custom-shader-animation = false",
  ].filter((line): line is string => line !== undefined);

  if (missingLines.length === 0) {
    return {
      appendedConfigLines: false,
      configPath,
      configUpdated: false,
      declined: false,
      shaderPath,
      shaderUpdated,
    };
  }

  const confirmed = await deps.confirm(
    "Update Ghostty config?",
    `Add the following to ${configPath}?\n\n${missingLines.join("\n")}`
  );
  if (!confirmed) {
    return {
      appendedConfigLines: false,
      configPath,
      configUpdated: false,
      declined: true,
      shaderPath,
      shaderUpdated,
    };
  }

  await withFileMutationQueue(configPath, async () => {
    const current = await readFile(configPath, "utf-8").catch(() => "");
    const separator = current.endsWith("\n") || current === "" ? "" : "\n";
    const leading = current === "" ? "" : "\n";
    await writeFile(
      configPath,
      `${current}${separator}${leading}${CONFIG_MARKER}\n${missingLines.join("\n")}\n`,
      "utf-8"
    );
  });

  return {
    appendedConfigLines: true,
    configPath,
    configUpdated: true,
    declined: false,
    shaderPath,
    shaderUpdated,
  };
};
