import path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ProjectExtensionPaths {
  configFile: string;
}

export interface ExtensionStoragePaths {
  cacheDir: string;
  configFile: string;
  dataDir: string;
  project: (cwd: string) => ProjectExtensionPaths;
}

const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const getExtensionStoragePaths = (id: string): ExtensionStoragePaths => {
  if (!EXTENSION_ID_PATTERN.test(id)) {
    throw new Error(`invalid extension ID: ${id}`);
  }

  const agentDir = getAgentDir();
  return {
    cacheDir: path.join(agentDir, "cache", id),
    configFile: path.join(agentDir, `${id}.json`),
    dataDir: path.join(agentDir, "data", id),
    project: (cwd) => ({
      configFile: path.join(path.resolve(cwd), CONFIG_DIR_NAME, `${id}.json`),
    }),
  };
};
