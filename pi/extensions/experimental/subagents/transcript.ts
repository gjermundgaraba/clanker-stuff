import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { open as openFile } from "node:fs/promises";

import { PermanentChildError } from "./permanent-error.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const lastPersistedEntryId = (
  sessionFile: string
): string | undefined => {
  const descriptor = openSync(sessionFile, "r");
  try {
    let position = fstatSync(descriptor).size;
    const chunks: Buffer[] = [];
    let total = 0;
    let foundContent = false;
    while (position > 0) {
      const length = Math.min(8192, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(descriptor, chunk, 0, length, position);
      let end = bytesRead;
      if (!foundContent) {
        while (
          end > 0 &&
          (chunk[end - 1] === 0x0a || chunk[end - 1] === 0x0d)
        ) {
          end -= 1;
        }
        if (end === 0) {
          continue;
        }
        foundContent = true;
      }
      const newline = chunk.lastIndexOf(0x0a, end - 1);
      const piece = chunk.subarray(newline + 1, end);
      chunks.unshift(piece);
      total += piece.length;
      if (newline === -1 && position > 0) {
        continue;
      }
      try {
        const entry: unknown = JSON.parse(
          Buffer.concat(chunks, total).toString("utf-8")
        );
        return isRecord(entry) && typeof entry.id === "string"
          ? entry.id
          : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    closeSync(descriptor);
  }
};

interface TranscriptEntry {
  id: string;
  parentId: string | null;
}

const parseEntries = (bytes: Buffer): TranscriptEntry[] =>
  bytes
    .toString("utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const entry: unknown = JSON.parse(line);
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        !(entry.parentId === null || typeof entry.parentId === "string")
      ) {
        throw new PermanentChildError(
          "Child transcript contains an invalid entry"
        );
      }
      return { id: entry.id, parentId: entry.parentId };
    });

/** Verifies each newly appended JSONL segment exactly once. */
export class TranscriptCursor {
  readonly #file: string;
  #offset: number;
  #parentId: string | undefined;
  readonly #seen = new Set<string>();
  readonly #strictParents: boolean;
  #tail: Promise<void> = Promise.resolve();

  constructor(file: string, strictParents = true) {
    this.#file = file;
    this.#strictParents = strictParents;
    this.#offset = statSync(file).size;
    this.#parentId = lastPersistedEntryId(file);
  }

  get parentId(): string | undefined {
    return this.#parentId;
  }

  verify(expectedId?: string): Promise<void> {
    const previous = this.#tail;
    const operation = (async () => {
      await previous;
      await this.#verifyNewEntries(expectedId);
    })();
    this.#tail = (async () => {
      try {
        await operation;
      } catch {
        // The caller observes the failure; later checks stay serialized.
      }
    })();
    return operation;
  }

  async barrier(): Promise<void> {
    await this.#tail;
  }

  async #verifyNewEntries(expectedId: string | undefined): Promise<void> {
    let found =
      expectedId === undefined ||
      expectedId === this.#parentId ||
      this.#seen.delete(expectedId);
    const file = await openFile(this.#file, "r");
    try {
      const info = await file.stat();
      if (info.size < this.#offset) {
        throw new PermanentChildError("Child transcript was truncated");
      }
      const length = info.size - this.#offset;
      if (length === 0) {
        if (!found) {
          throw new PermanentChildError(
            `Session entry ${expectedId} was not persisted`
          );
        }
        return;
      }
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(bytes, 0, length, this.#offset);
      if (bytesRead !== length) {
        throw new PermanentChildError("Unable to read child transcript");
      }
      if (bytes.at(-1) !== 0x0a) {
        throw new PermanentChildError(
          "Child transcript ended with an incomplete entry"
        );
      }
      let parent = this.#parentId;
      for (const entry of parseEntries(bytes)) {
        if (this.#strictParents && entry.parentId !== (parent ?? null)) {
          throw new PermanentChildError(
            "Child transcript parent chain is discontinuous"
          );
        }
        parent = entry.id;
        if (entry.id === expectedId) {
          found = true;
        } else if (this.#strictParents) {
          this.#seen.add(entry.id);
        }
      }
      this.#offset = info.size;
      this.#parentId = parent;
      if (!found) {
        throw new PermanentChildError(
          `Session entry ${expectedId} was not persisted`
        );
      }
    } catch (error) {
      throw error instanceof PermanentChildError
        ? error
        : new PermanentChildError(
            error instanceof Error ? error.message : String(error),
            { cause: error }
          );
    } finally {
      await file.close();
    }
  }
}
