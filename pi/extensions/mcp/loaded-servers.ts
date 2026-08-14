import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const loadedServerNames = (
  branch: readonly SessionEntry[]
): string[] => {
  const names = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "mcp-server-loaded") {
      continue;
    }
    const { data } = entry;
    if (
      typeof data === "object" &&
      data !== null &&
      "serverName" in data &&
      typeof data.serverName === "string" &&
      data.serverName !== ""
    ) {
      names.add(data.serverName);
    }
  }
  return [...names];
};
