import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { snapshotSchema } from "xstate/persist";

import { waitMachine } from "./machine.js";

export const WAIT_ENTRY = "waits:wait";

const envelopeSchema = Type.Object({
  v: Type.Literal(1),
  id: Type.String({ minLength: 1 }),
  owner: Type.String({ minLength: 1 }),
  snapshot: Type.Unknown(),
});

const thisMachineSchema = Type.Object({
  machine: Type.Object({
    id: Type.Literal(waitMachine.id),
    version: Type.Literal(waitMachine.version ?? ""),
  }),
});

const persistedWait = snapshotSchema(waitMachine)["~standard"];

/** One journaled phase change: the whole persisted actor, keyed and owned. */
export const waitEntry = (owner: string, id: string, snapshot: unknown) => ({
  v: 1,
  id,
  owner,
  snapshot,
});

const parseSnapshot = async (data: unknown) => {
  if (!Value.Check(thisMachineSchema, data)) {
    return undefined;
  }

  const result = await persistedWait.validate(data);

  return result.issues === undefined ? result.value : undefined;
};

/**
 * The newest snapshot of every wait on the branch that `owner` opened. A
 * fork or clone copies the branch under a new session id, so it inherits
 * none. A newest entry from another machine version, or one that does
 * not fit this machine, drops the wait rather than reviving an older entry.
 */
export const ownedWaits = async (
  branch: readonly SessionEntry[],
  owner: string
) => {
  const latest = new Map<string, unknown>();

  for (const entry of branch) {
    if (
      entry.type === "custom" &&
      entry.customType === WAIT_ENTRY &&
      Value.Check(envelopeSchema, entry.data) &&
      entry.data.owner === owner
    ) {
      latest.delete(entry.data.id);
      latest.set(entry.data.id, entry.data.snapshot);
    }
  }

  const parsed = await Promise.all([...latest.values()].map(parseSnapshot));

  return parsed.filter((snapshot) => snapshot !== undefined);
};
