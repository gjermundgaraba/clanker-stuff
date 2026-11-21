import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { parkedItemSchema } from "@clanker-stuff/presence-protocol";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const KEEP_STOPPED_MS = 24 * 60 * 60 * 1000;

export const recordSchema = Type.Object(
  {
    pid: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String()),
    cwd: Type.String(),
    startedAt: Type.Integer(),
    updatedAt: Type.Integer(),
    activity: Type.Union([
      Type.Literal("idle"),
      Type.Literal("busy"),
      Type.Literal("dialog"),
    ]),
    since: Type.Integer(),
    tool: Type.Optional(Type.String()),
    parked: Type.Array(
      Type.Object(
        {
          source: Type.String({ minLength: 1 }),
          ...parkedItemSchema.properties,
        },
        { additionalProperties: false }
      )
    ),
    endedAt: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false }
);

export type PresenceRecord = Static<typeof recordSchema>;

export const presenceDir = (): string =>
  getExtensionStoragePaths("presence").dataDir;

export const recordFile = (dir: string, pid: number): string =>
  path.join(dir, `${pid}.json`);

/** Whether a process is running. A process we may not signal still counts. */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const writeRecord = async (
  dir: string,
  record: PresenceRecord
): Promise<void> => {
  await mkdir(dir, { recursive: true });

  const temporary = path.join(dir, `.${randomBytes(6).toString("hex")}.tmp`);

  await writeFile(temporary, JSON.stringify(record));
  await rename(temporary, recordFile(dir, record.pid));
};

const readRecord = async (
  file: string
): Promise<PresenceRecord | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));

    return Value.Check(recordSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Every readable record in `dir`. A missing directory has none. */
export const readRecords = async (dir: string): Promise<PresenceRecord[]> => {
  const names = await readdir(dir).catch(() => []);

  const records = await Promise.all(
    names
      .filter((name) => /^\d+\.json$/u.test(name))
      .map(async (name) => await readRecord(path.join(dir, name)))
  );

  return records.filter((record) => record !== undefined);
};

/** Deletes the records of processes that are gone and were last seen over a day ago. */
export const pruneRecords = async (dir: string, now: number): Promise<void> => {
  const records = await readRecords(dir);

  await Promise.all(
    records
      .filter(
        (record) =>
          now - record.updatedAt > KEEP_STOPPED_MS && !isAlive(record.pid)
      )
      .map(async (record) => {
        await rm(recordFile(dir, record.pid), { force: true });
      })
  );
};
