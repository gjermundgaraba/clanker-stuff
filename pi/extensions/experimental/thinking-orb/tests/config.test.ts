import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createOrbConfigStore,
  DEFAULT_CONFIG,
  parseOrbConfig,
} from "../config.js";

describe("thinking-orb config", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "thinking-orb-config-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  const configPath = () => path.join(configDir, "thinking-orb.json");

  describe("config store", () => {
    it("returns defaults without creating a missing file", async () => {
      const store = createOrbConfigStore(configPath());
      const loaded = await store.load();
      expect(loaded.config).toStrictEqual(DEFAULT_CONFIG);
      expect(loaded.error).toBeUndefined();
      await expect(readdir(configDir)).resolves.toStrictEqual([]);
    });

    it("round-trips a saved config", async () => {
      const store = createOrbConfigStore(configPath());
      await store.save({
        autoStart: false,
        backingScale: 2,
        enabled: true,
        fps: 30,
        version: 1,
      });
      const loaded = await store.load();
      expect(loaded.config).toStrictEqual({
        autoStart: false,
        backingScale: 2,
        enabled: true,
        fps: 30,
        version: 1,
      });
      expect(loaded.error).toBeUndefined();
      const text = await readFile(configPath(), "utf-8");
      expect(JSON.parse(text).fps).toBe(30);
    });

    it("falls back to defaults with an error for invalid files", async () => {
      await writeFile(configPath(), "{ not json", "utf-8");
      const store = createOrbConfigStore(configPath());
      const loaded = await store.load();
      expect(loaded.config).toStrictEqual(DEFAULT_CONFIG);
      expect(loaded.error).toContain("Invalid");
    });
  });

  describe("config parsing", () => {
    it("rejects unknown keys and out-of-range frame rates", () => {
      expect(() =>
        parseOrbConfig({
          autoStart: true,
          enabled: true,
          extra: true,
          fps: 60,
          version: 1,
        })
      ).toThrow(/config must be/u);
      expect(() =>
        parseOrbConfig({
          autoStart: true,
          enabled: true,
          fps: 120,
          version: 1,
        })
      ).toThrow(/config must be/u);
    });

    it("rejects invalid backing scales", () => {
      expect(() =>
        parseOrbConfig({
          autoStart: true,
          backingScale: 4,
          enabled: true,
          fps: 60,
          version: 1,
        })
      ).toThrow(/config must be/u);
    });
  });
});
