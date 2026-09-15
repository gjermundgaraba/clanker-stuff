import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { historyItemFromEntry, type HistoryItem } from "./history.js";
import { saveHistoryBatch } from "./storage.js";

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
  signal: AbortSignal,
): Promise<HistoryItem[] | undefined> => {
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const history: HistoryItem[] = [];
  let hasHeader = false;
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry) continue;
      if (!hasHeader) {
        // Like Pi's discovery, require the first parsed entry to be a session header.
        if (typeof entry !== "object" || !("type" in entry) || entry.type !== "session") {
          return undefined;
        }
        hasHeader = true;
        continue;
      }
      const item = historyItemFromEntry(entry);
      if (item) history.push(item);
    }
    return hasHeader ? history : undefined;
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
  signal: AbortSignal,
): Promise<number> => {
  signal.throwIfAborted();
  const defaultRoot = path.join(getAgentDir(), "sessions");
  const directories = new Set(
    (await listDirectory(defaultRoot))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(defaultRoot, entry.name)),
  );
  if (currentSessionDirectory) directories.add(path.resolve(currentSessionDirectory));

  const candidates: string[] = [];
  for (const directory of directories) {
    signal.throwIfAborted();
    for (const entry of await listDirectory(directory)) {
      if (entry.name.endsWith(".jsonl")) candidates.push(path.join(directory, entry.name));
    }
    onProgress(`discovering history: ${candidates.length} files`);
  }

  let files = 0;
  for (const [index, file] of candidates.sort().entries()) {
    signal.throwIfAborted();
    const entries = await readSessionHistory(file, signal);
    signal.throwIfAborted();
    if (entries) {
      saveHistoryBatch(database, entries);
      files += 1;
    }
    onProgress(`importing history: ${index + 1}/${candidates.length} files`);
    await yieldToEventLoop();
    signal.throwIfAborted();
  }
  signal.throwIfAborted();
  return files;
};
