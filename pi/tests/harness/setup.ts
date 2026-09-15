import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll } from "vite-plus/test";

import { patchEnv } from "../helpers/env.js";

let homeDir: string | undefined;
let restoreEnv: (() => void) | undefined;

beforeAll(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-extensions-home-"));

  restoreEnv = patchEnv({
    HOME: homeDir,
    PI_CODING_AGENT_DIR: path.join(homeDir, ".pi", "agent"),
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
  });
  // Pi's interactive host always has a theme loaded; extension UI that uses Pi's theme helpers
  // (markdown themes, syntax highlighting) relies on it. The patched HOME hides user themes.
  initTheme("dark");
});

afterAll(async () => {
  restoreEnv?.();
  restoreEnv = undefined;

  if (homeDir) {
    await rm(homeDir, { force: true, recursive: true });
    homeDir = undefined;
  }
});
