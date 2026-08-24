import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const loadedServerNames = (branch: readonly SessionEntry[]): string[] => {
  const names = new Set<string>();
  const dataSchema = Type.Object({ serverName: Type.String({ minLength: 1 }) });
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "mcp-server-loaded") {
      continue;
    }
    const { data } = entry;
    if (Value.Check(dataSchema, data)) {
      names.add(Value.Parse(dataSchema, data).serverName);
    }
  }
  return [...names];
};
