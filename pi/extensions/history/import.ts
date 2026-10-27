import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { historyItemFromEntry } from "./history.js";
import type { HistoryItem } from "./history.js";
import { saveHistoryBatch } from "./storage.js";

const SessionHeaderSchema = Type.Object({ type: Type.Literal("session") });

const listDirectory = async (directory: string) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    // Session directories can disappear or be unreadable during discovery.
    return [];
  }
};

const readSessionHistory = async (
  file: string,
  signal: AbortSignal
): Promise<HistoryItem[] | undefined> => {
  const stream = createReadStream(file, { encoding: "utf-8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let history: HistoryItem[] | undefined;

  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      let entry: unknown;

      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry === null || entry === false || entry === 0 || entry === "") {
        continue;
      }

      if (history === undefined) {
        // Like Pi's discovery, require the first parsed entry to be a session header.
        if (!Value.Check(SessionHeaderSchema, entry)) {
          return undefined;
        }

        history = [];
        continue;
      }

      const item = historyItemFromEntry(entry);

      if (item) {
        history.push(item);
      }
    }

    return history;
  } catch {
    signal.throwIfAborted();

    // A concurrently deleted or unreadable file should not fail the import.
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
};

export const importPersistentHistory = async (
  database: DatabaseSync,
  currentSessionDirectory: string,
  onProgress: (status: string) => void,
  signal: AbortSignal
): Promise<number> => {
  signal.throwIfAborted();
  const defaultRoot = path.join(getAgentDir(), "sessions");

  const defaultEntries = await listDirectory(defaultRoot);

  const directories = new Set(
    defaultEntries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(defaultRoot, entry.name))
  );

  if (currentSessionDirectory) {
    directories.add(path.resolve(currentSessionDirectory));
  }

  const candidates: string[] = [];

  for (const directory of directories) {
    signal.throwIfAborted();

    for (const entry of await listDirectory(directory)) {
      if (entry.name.endsWith(".jsonl")) {
        candidates.push(path.join(directory, entry.name));
      }
    }

    onProgress(`discovering history: ${candidates.length} files`);
  }

  let files = 0;

  for (const [index, file] of candidates.toSorted().entries()) {
    signal.throwIfAborted();
    const entries = await readSessionHistory(file, signal);
    signal.throwIfAborted();

    if (entries) {
      saveHistoryBatch(database, entries);
      files += 1;
    }

    onProgress(`importing history: ${index + 1}/${candidates.length} files`);
    await yieldToEventLoop();
  }

  signal.throwIfAborted();

  return files;
};
