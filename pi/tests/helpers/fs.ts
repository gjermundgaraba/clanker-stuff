import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const createTempDir = (prefix = "clanker-stuff-") =>
  mkdtemp(path.join(os.tmpdir(), prefix));

export const linkDirectory = async (src: string, dest: string) => {
  await mkdir(path.dirname(dest), { recursive: true });
  await symlink(
    path.resolve(src),
    dest,
    process.platform === "win32" ? "junction" : "dir"
  );
};
