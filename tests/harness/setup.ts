import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll } from "vitest";

let homeDir: string | undefined;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalXdgConfigHome: string | undefined;
let hadHome = false;
let hadUserProfile = false;
let hadXdgConfigHome = false;

beforeAll(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-extensions-home-"));

  hadHome = Object.hasOwn(process.env, "HOME");
  hadUserProfile = Object.hasOwn(process.env, "USERPROFILE");
  hadXdgConfigHome = Object.hasOwn(process.env, "XDG_CONFIG_HOME");
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
});

afterAll(async () => {
  if (hadHome) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }

  if (hadUserProfile) {
    process.env.USERPROFILE = originalUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }

  if (hadXdgConfigHome) {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }

  if (homeDir) {
    await rm(homeDir, { force: true, recursive: true });
    homeDir = undefined;
  }
});
