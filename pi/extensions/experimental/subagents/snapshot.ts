import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { V1SnapshotSchema } from "./v1/protocol.js";
import { V2SnapshotSchema } from "./v2/protocol.js";

export const MAX_CONTROL_BYTES = 16 * 1024 * 1024;
export const MAX_DURABLE_RESULT_BYTES = 256 * 1024;
const TERMINAL_RECORD_OVERHEAD_BYTES = 4096;
const MAX_TERMINAL_GROWTH_BYTES =
  3 * MAX_DURABLE_RESULT_BYTES + TERMINAL_RECORD_OVERHEAD_BYTES;

const RootBindingSchema = Type.Object(
  {
    sessionFile: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    sessionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
const Common = {
  nicknames: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  revision: Type.Integer({ minimum: 0 }),
  root: RootBindingSchema,
  version: Type.Literal(1),
};
export const SnapshotSchema = Type.Union([
  Type.Object(
    {
      ...Common,
      protocolLatch: Type.Literal("off"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...Common,
      protocolLatch: Type.Literal("v1"),
      state: V1SnapshotSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...Common,
      protocolLatch: Type.Literal("v2"),
      state: V2SnapshotSchema,
    },
    { additionalProperties: false }
  ),
]);
export type RootBinding = Static<typeof RootBindingSchema>;
export type SubagentsSnapshot = Static<typeof SnapshotSchema>;
const SUCCESSFUL_WRITE: Error | undefined = undefined;

export interface ControlStore {
  readonly persistent: boolean;
  load: () => Promise<SubagentsSnapshot | undefined>;
  write: (
    serialized: string,
    onCommit: () => void
  ) => Promise<Error | undefined>;
}

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) {
    throw new Error(`Subagent control snapshot has duplicate ${label}`);
  }
};

const sameMembers = (
  left: readonly string[],
  right: readonly string[]
): boolean => {
  const leftMembers = new Set(left);
  return (
    left.length === right.length &&
    leftMembers.size === left.length &&
    right.every((value) => leftMembers.has(value))
  );
};

const assertV1Semantics = (
  snapshot: Extract<SubagentsSnapshot, { protocolLatch: "v1" }>
): void => {
  const { agents, notifications } = snapshot.state;
  const agentIds = new Set(agents.map(({ id }) => id));
  assertUnique(
    agents.map(({ id }) => id),
    "V1 agent ids"
  );
  assertUnique(
    agents.map(({ sessionFile }) => sessionFile),
    "V1 session files"
  );
  assertUnique(
    notifications.map(({ id }) => id),
    "V1 notification ids"
  );
  const turnIds = agents.flatMap((agent) => [
    ...(agent.active === undefined ? [] : [agent.active.id]),
    ...agent.queue.map(({ id }) => id),
  ]);
  assertUnique(turnIds, "V1 turn ids");
  assertUnique(
    [...turnIds, ...notifications.map(({ id }) => id)],
    "V1 turn and notification ids"
  );
  if (
    !sameMembers(
      snapshot.nicknames,
      agents.map(({ nickname }) => nickname)
    )
  ) {
    throw new Error("V1 nickname reservations do not match its agents");
  }
  for (const notification of notifications) {
    if (!agentIds.has(notification.agentId)) {
      throw new Error(
        `V1 notification references an unknown agent: ${notification.id}`
      );
    }
  }
};

type V2Snapshot = Extract<SubagentsSnapshot, { protocolLatch: "v2" }>["state"];
type V2Communication = V2Snapshot["communications"][number];
type V2Node = V2Snapshot["nodes"][number];

const assertV2Node = (
  node: V2Node,
  nodePaths: ReadonlySet<string>,
  communicationsById: ReadonlyMap<string, V2Communication>
): void => {
  const parent = node.path.slice(0, node.path.lastIndexOf("/"));
  if (!nodePaths.has(parent)) {
    throw new Error(`V2 agent has no durable parent: ${node.path}`);
  }
  const activeCommunication = communicationsById.get(
    node.activeDeliveryId ?? ""
  );
  if (
    node.status === "pending" &&
    (activeCommunication?.delivery !== "turn" ||
      activeCommunication.to !== node.path)
  ) {
    throw new Error(`Pending V2 agent has no task mail: ${node.path}`);
  }
  if (node.status === "running" && activeCommunication !== undefined) {
    throw new Error(`Running V2 agent still owns task mail: ${node.path}`);
  }
};

const assertV2Communication = (
  communication: V2Communication,
  nodePaths: ReadonlySet<string>,
  nodesByPath: ReadonlyMap<string, V2Node>
): void => {
  if (!nodePaths.has(communication.from) || !nodePaths.has(communication.to)) {
    throw new Error(
      `V2 communication references an unknown agent: ${communication.id}`
    );
  }
  if (
    communication.delivery === "turn" &&
    nodesByPath.get(communication.to)?.activeDeliveryId !== communication.id
  ) {
    throw new Error(
      `V2 task mail is not owned by its target: ${communication.id}`
    );
  }
};

const assertV2Semantics = (
  snapshot: Extract<SubagentsSnapshot, { protocolLatch: "v2" }>
): void => {
  const { communications, nodes } = snapshot.state;
  const communicationsById = new Map(
    communications.map((communication) => [communication.id, communication])
  );
  assertUnique(
    nodes.map(({ path: pathname }) => pathname),
    "V2 agent paths"
  );
  assertUnique(
    nodes.map(({ sessionFile }) => sessionFile),
    "V2 session files"
  );
  assertUnique(
    communications.map(({ id }) => id),
    "V2 communication ids"
  );
  assertUnique(
    nodes.flatMap(({ activeDeliveryId }) =>
      activeDeliveryId === undefined ? [] : [activeDeliveryId]
    ),
    "V2 active-delivery ids"
  );
  const nodePaths = new Set([
    "/root",
    ...nodes.map(({ path: pathname }) => pathname),
  ]);
  const nodesByPath = new Map(nodes.map((node) => [node.path, node]));
  const nodeNicknames = nodes.map(({ nickname }) => nickname);
  if (!sameMembers(snapshot.nicknames, nodeNicknames)) {
    throw new Error("V2 nickname reservations do not match its agents");
  }
  for (const node of nodes) {
    assertV2Node(node, nodePaths, communicationsById);
  }
  for (const communication of communications) {
    assertV2Communication(communication, nodePaths, nodesByPath);
  }
};

const assertSnapshotSemantics = (snapshot: SubagentsSnapshot): void => {
  if (snapshot.protocolLatch === "off") {
    if (snapshot.nicknames.length !== 0) {
      throw new Error("Disabled subagent state cannot reserve nicknames");
    }
    return;
  }
  if (snapshot.protocolLatch === "v1") {
    assertV1Semantics(snapshot);
    return;
  }
  assertV2Semantics(snapshot);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const migrateLegacyV1QueuePhases = (value: unknown): unknown => {
  if (
    !isRecord(value) ||
    value.protocolLatch !== "v1" ||
    !isRecord(value.state) ||
    !isUnknownArray(value.state.agents)
  ) {
    return value;
  }
  return {
    ...value,
    state: {
      ...value.state,
      agents: value.state.agents.map((agent) => {
        if (!isRecord(agent) || !isUnknownArray(agent.queue)) {
          return agent;
        }
        return {
          ...agent,
          queue: agent.queue.map((turn) => {
            if (
              !isRecord(turn) ||
              (turn.phase !== "pending" && turn.phase !== "running")
            ) {
              return turn;
            }
            const migrated = { ...turn };
            delete migrated.phase;
            return migrated;
          }),
        };
      }),
    },
  };
};

const assertSnapshot = (
  value: unknown,
  expectedRoot: RootBinding
): SubagentsSnapshot => {
  if (!Value.Check(SnapshotSchema, value)) {
    throw new Error("Invalid subagent control snapshot");
  }
  if (
    value.root.sessionId !== expectedRoot.sessionId ||
    value.root.sessionFile !== expectedRoot.sessionFile
  ) {
    throw new Error("Subagent control snapshot belongs to another root");
  }
  assertSnapshotSemantics(value);
  return value;
};

const serializedSize = (serialized: string): number =>
  Buffer.byteLength(serialized, "utf-8");

const encodedTextSize = (value: string): number =>
  Buffer.byteLength(JSON.stringify(value), "utf-8") - 2;

const terminalHeadroom = (snapshot: SubagentsSnapshot): number => {
  if (snapshot.protocolLatch === "off") {
    return 0;
  }
  const activeCount =
    snapshot.protocolLatch === "v1"
      ? snapshot.state.agents.filter(({ active }) => active !== undefined)
          .length
      : snapshot.state.nodes.filter(
          ({ status }) => status === "pending" || status === "running"
        ).length;
  return activeCount * MAX_TERMINAL_GROWTH_BYTES;
};

export const serializeSnapshot = (
  snapshot: SubagentsSnapshot,
  reserveTerminalHeadroom = false
): string => {
  if (!Value.Check(SnapshotSchema, snapshot)) {
    throw new Error("Invalid subagent control state");
  }
  assertSnapshotSemantics(snapshot);
  const serialized = JSON.stringify(snapshot);
  const maximum = reserveTerminalHeadroom
    ? MAX_CONTROL_BYTES - terminalHeadroom(snapshot)
    : MAX_CONTROL_BYTES;
  if (serializedSize(serialized) > maximum) {
    throw new Error(
      reserveTerminalHeadroom
        ? "Subagent operation would leave insufficient terminal-state headroom"
        : "Subagent control state exceeds its maximum size"
    );
  }
  return serialized;
};

export const boundDurableText = (
  value: string,
  maximum = MAX_DURABLE_RESULT_BYTES
): string => {
  if (encodedTextSize(value) <= maximum) {
    return value;
  }
  const marker = "…";
  if (encodedTextSize(marker) > maximum) {
    return "";
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const end =
      middle > 0 && /[\uD800-\uDBFF]/u.test(value[middle - 1] ?? "")
        ? middle - 1
        : middle;
    if (encodedTextSize(`${value.slice(0, end)}${marker}`) <= maximum) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const end =
    low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? "") ? low - 1 : low;
  return `${value.slice(0, end)}${marker}`;
};

export const createMemoryControlStore = (
  snapshot?: SubagentsSnapshot
): ControlStore => {
  let current = snapshot === undefined ? undefined : structuredClone(snapshot);
  return {
    load: () =>
      Promise.resolve(
        current === undefined ? undefined : structuredClone(current)
      ),
    persistent: false,
    write: (serialized, onCommit) => {
      current = Value.Decode(SnapshotSchema, JSON.parse(serialized));
      onCommit();
      return Promise.resolve(SUCCESSFUL_WRITE);
    },
  };
};

class FileControlStore implements ControlStore {
  readonly #directory: string;
  readonly #filePath: string;
  readonly persistent = true;
  readonly #root: RootBinding;

  constructor(directory: string, filePath: string, root: RootBinding) {
    this.#directory = directory;
    this.#filePath = filePath;
    this.#root = root;
  }

  async load(): Promise<SubagentsSnapshot | undefined> {
    return await withFileMutationQueue(this.#filePath, async () => {
      await this.#prepareDirectory();
      await this.#removeStaleTemporaryFiles();
      let info;
      let missing = false;
      try {
        info = await lstat(this.#filePath);
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          missing = true;
        } else {
          throw error;
        }
      }
      let snapshot: SubagentsSnapshot | undefined;
      if (!missing && info !== undefined) {
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error("Subagent control state must be a regular file");
        }
        if (info.size > MAX_CONTROL_BYTES) {
          throw new Error("Subagent control state exceeds its maximum size");
        }
        const contents = await readFile(this.#filePath, "utf-8");
        snapshot = assertSnapshot(
          migrateLegacyV1QueuePhases(JSON.parse(contents)),
          this.#root
        );
      }
      return snapshot;
    });
  }

  async write(
    serialized: string,
    onCommit: () => void
  ): Promise<Error | undefined> {
    if (serializedSize(serialized) > MAX_CONTROL_BYTES) {
      throw new Error("Subagent control state exceeds its maximum size");
    }
    return await withFileMutationQueue(this.#filePath, async () => {
      await this.#prepareDirectory();
      try {
        const existing = await lstat(this.#filePath);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error("Subagent control state must be a regular file");
        }
      } catch (error) {
        if (
          !(
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }

      const temporaryPath = `${this.#filePath}.tmp-${process.pid}-${randomUUID()}`;
      let renamed = false;
      try {
        const temporary = await open(temporaryPath, "wx", 0o600);
        try {
          await temporary.writeFile(serialized, "utf-8");
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        await rename(temporaryPath, this.#filePath);
        renamed = true;
        onCommit();
        try {
          const directory = await open(this.#directory, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } catch (error) {
          return new Error(
            `Subagent control state was renamed but directory sync failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
        return SUCCESSFUL_WRITE;
      } finally {
        if (!renamed) {
          await rm(temporaryPath, { force: true });
        }
      }
    });
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { mode: 0o700, recursive: true });
    const info = await lstat(this.#directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Subagent control directory must be a regular directory");
    }
    await chmod(this.#directory, 0o700);
  }

  async #removeStaleTemporaryFiles(): Promise<void> {
    const prefix = `${path.basename(this.#filePath)}.tmp-`;
    const entries = await readdir(this.#directory, {
      withFileTypes: true,
    });
    await Promise.all(
      entries
        .filter((entry) => entry.name.startsWith(prefix) && entry.isFile())
        .map((entry) =>
          rm(path.join(this.#directory, entry.name), { force: true })
        )
    );
  }
}

const normalizedRootFile = (sessionFile: string): string =>
  path.resolve(sessionFile);

export const rootBinding = (
  sessionId: string,
  sessionFile?: string
): RootBinding => ({
  sessionFile:
    sessionFile === undefined ? null : normalizedRootFile(sessionFile),
  sessionId,
});

export const createControlStore = (
  dataDir: string,
  root: RootBinding
): ControlStore => {
  if (root.sessionFile === null) {
    return createMemoryControlStore();
  }
  const directory = path.resolve(dataDir, "trees");
  const key = createHash("sha256")
    .update(`${root.sessionFile}\0${root.sessionId}`)
    .digest("hex");
  return new FileControlStore(directory, path.join(directory, `${key}.json`), {
    ...root,
    sessionFile: normalizedRootFile(root.sessionFile),
  });
};

export const freshSnapshot = (
  protocol: "off" | "v1" | "v2",
  root: RootBinding
): SubagentsSnapshot => {
  const common = {
    nicknames: [],
    protocolLatch: protocol,
    revision: 0,
    root,
    version: 1 as const,
  };
  if (protocol === "off") {
    return { ...common, protocolLatch: "off" };
  }
  if (protocol === "v1") {
    return {
      ...common,
      protocolLatch: "v1",
      state: { agents: [], notifications: [] },
    };
  }
  return {
    ...common,
    protocolLatch: "v2",
    state: { communications: [], nodes: [] },
  };
};
