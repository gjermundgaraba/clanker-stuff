import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll } from "vitest";

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
});

afterAll(async () => {
  restoreEnv?.();
  restoreEnv = undefined;

  if (homeDir) {
    await rm(homeDir, { force: true, recursive: true });
    homeDir = undefined;
  }
});
