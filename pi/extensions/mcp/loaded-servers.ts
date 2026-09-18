import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const dataSchema = Type.Object({ serverName: Type.String({ minLength: 1 }) });

export const loadedServerNames = (branch: readonly SessionEntry[]): string[] => {
  const names = new Set<string>();

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "mcp-server-loaded") {
      continue;
    }

    const { data } = entry;

    if (Value.Check(dataSchema, data)) {
      names.add(data.serverName);
    }
  }

  return [...names];
};
