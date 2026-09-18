import { DEFAULT_CONFIG } from "@clanker-stuff/footer-protocol/config";
import { createFooterConfigStore } from "../../footer/config.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { loadConfig, loadFooterPreference, saveConfig } from "../config.js";

it("defaults without creating files and roundtrips an explicit icon preference", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "border-config-"));
  const file = path.join(dir, "nested", "border.json");

  try {
    expect(await loadConfig(file)).toEqual({ version: 1, iconFamily: "inherit" });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await loadFooterPreference(file)).toBe("unicode");
    await saveConfig({ version: 1, iconFamily: "nerd" }, file);
    expect(await loadConfig(file)).toEqual({ version: 1, iconFamily: "nerd" });
    expect(await loadFooterPreference(file)).toBe("unicode");
    await writeFile(file, '{"iconFamily":"bogus"}');
    expect(await loadFooterPreference(file)).toBe("unicode");
    expect(await loadConfig(file)).toEqual({ version: 1, iconFamily: "inherit" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("inherits the same fully validated configuration as the footer, not just its icon field", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "footer-inheritance-"));
  const file = path.join(dir, "footer.json");

  try {
    const store = createFooterConfigStore(file);

    for (const contents of [
      undefined,
      "not json",
      JSON.stringify({ iconFamily: "nerd" }),
      JSON.stringify({ ...DEFAULT_CONFIG, iconFamily: "nerd", unexpected: true }),
      JSON.stringify({ ...DEFAULT_CONFIG, iconFamily: "nerd", rows: [] }),
      JSON.stringify({ ...DEFAULT_CONFIG, iconFamily: "nerd" }),
    ]) {
      if (contents !== undefined) await writeFile(file, contents);
      const inherited = await loadFooterPreference(file);
      expect(inherited).toBe((await store.load()).config.iconFamily);
    }

    expect(await loadFooterPreference(file)).toBe("nerd");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
