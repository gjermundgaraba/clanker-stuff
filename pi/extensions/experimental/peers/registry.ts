import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const peerSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    pid: Type.Integer({ minimum: 1 }),
    cwd: Type.String(),
  },
  { additionalProperties: false }
);

export type Peer = Static<typeof peerSchema>;

const fileOf = (dir: string, name: string): string =>
  path.join(dir, `${createHash("sha256").update(name).digest("hex")}.json`);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const readPeer = async (file: string): Promise<Peer | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));

    return Value.Check(peerSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
export const writeAtomic = async (
  file: string,
  value: unknown
): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });

  const temporary = path.join(
    path.dirname(file),
    `.${randomBytes(6).toString("hex")}.tmp`
  );

  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
};

/** The live session holding `name`, if any. A file left by a dead process counts as no one. */
export const lookup = async (
  dir: string,
  name: string
): Promise<Peer | undefined> => {
  const peer = await readPeer(fileOf(dir, name));

  return peer?.name === name && isAlive(peer.pid) ? peer : undefined;
};

/** Every live session with a name, sorted by name. */
export const livePeers = async (dir: string): Promise<Peer[]> => {
  const names = await readdir(dir).catch(() => []);

  const peers = await Promise.all(
    names
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => await readPeer(path.join(dir, file)))
  );

  return peers
    .filter((peer): peer is Peer => peer !== undefined && isAlive(peer.pid))
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/**
 * Takes `self.name` for `self`, unless another live session holds it.
 * Returns that holder, or undefined once the name is this session's.
 */
export const claim = async (
  dir: string,
  self: Peer
): Promise<Peer | undefined> => {
  const holder = await lookup(dir, self.name);

  if (holder !== undefined && holder.sessionId !== self.sessionId) {
    return holder;
  }

  await writeAtomic(fileOf(dir, self.name), self);

  const after = await lookup(dir, self.name);

  return after?.sessionId === self.sessionId ? undefined : after;
};

/** Gives up `name` if `sessionId` still holds it. */
export const release = async (
  dir: string,
  name: string,
  sessionId: string
): Promise<void> => {
  const file = fileOf(dir, name);
  const peer = await readPeer(file);

  if (peer?.sessionId === sessionId) {
    await rm(file, { force: true });
  }
};
