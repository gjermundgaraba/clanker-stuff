import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ExtensionStoragePaths {
  configFile: string;
  dataDir: string;
}

const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const getExtensionStoragePaths = (id: string): ExtensionStoragePaths => {
  if (!EXTENSION_ID_PATTERN.test(id)) {
    throw new Error(`invalid extension ID: ${id}`);
  }

  const agentDir = getAgentDir();

  return {
    configFile: path.join(agentDir, `${id}.json`),
    dataDir: path.join(agentDir, "data", id),
  };
};
