import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { Type } from "typebox";
import { Value } from "typebox/value";

const MAX_STASHES = 10;
const LegacyStackSchema = Type.Object({ entries: Type.Array(Type.String()) });

const StoredStackSchema = Type.Object({
  entries: Type.Array(Type.String(), { maxItems: MAX_STASHES }),
});

const StackRowSchema = Type.Object({ contents: Type.String() });

const getStoreFiles = (cwd: string) => {
  const { dataDir } = getExtensionStoragePaths("stash");
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex");

  return {
    dataDir,
    databaseFile: path.join(dataDir, `${key}.sqlite`),
    legacyFile: path.join(dataDir, `${key}.json`),
  };
};

export class LegacyStashError extends Error {
  constructor(file: string, cause: unknown) {
    super(
      `Could not import legacy stash ${JSON.stringify(file)}; file left untouched.`,
      {
        cause,
      }
    );
    this.name = "LegacyStashError";
  }
}

const readLegacyStack = (file: string): string[] => {
  try {
    const bytes = readFileSync(file);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const data: unknown = JSON.parse(json);

    if (!Value.Check(LegacyStackSchema, data)) {
      throw new TypeError("Invalid legacy stash stack");
    }

    return data.entries.slice(-MAX_STASHES);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw new LegacyStashError(file, error);
  }
};

const readStack = (database: DatabaseSync): string[] => {
  const row = database.prepare("SELECT contents FROM stash WHERE id = 1").get();

  if (!Value.Check(StackRowSchema, row)) {
    throw new TypeError("Missing or invalid stash record");
  }

  const data: unknown = JSON.parse(row.contents);

  if (!Value.Check(StoredStackSchema, data)) {
    throw new TypeError("Invalid stash stack");
  }

  return data.entries;
};

const mutateStack = <Result>(
  { dataDir, databaseFile, legacyFile }: ReturnType<typeof getStoreFiles>,
  mutate: (entries: string[]) => Result
): Result => {
  mkdirSync(dataDir, { mode: 0o700, recursive: true });
  using database = new DatabaseSync(databaseFile, { timeout: 250 });

  database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");

  const version = database.prepare("PRAGMA user_version").get()?.[
    "user_version"
  ];

  if (version !== 0 && version !== 1) {
    throw new Error("Unsupported stash database version");
  }

  const entries =
    version === 0 ? readLegacyStack(legacyFile) : readStack(database);

  const result = mutate(entries);

  if (version === 0) {
    database.exec(`
      CREATE TABLE stash (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        contents TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `);
  }

  if (version === 0 || result !== undefined) {
    database
      .prepare(`
      INSERT INTO stash (id, contents) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET contents = excluded.contents
    `)
      .run(JSON.stringify({ entries }));
  }

  database.exec("COMMIT");

  return result;
};

export const pushStash = (cwd: string, text: string) =>
  mutateStack(getStoreFiles(cwd), (entries) => {
    entries.push(text);

    if (entries.length > MAX_STASHES) {
      entries.shift();
    }

    return entries.length;
  });

export const popStash = (cwd: string) => {
  const files = getStoreFiles(cwd);

  if (
    !statSync(files.databaseFile, { throwIfNoEntry: false }) &&
    !statSync(files.legacyFile, { throwIfNoEntry: false })
  ) {
    return undefined;
  }

  return mutateStack(files, (entries) => entries.pop());
};
