import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import type { PatchChange, PatchDiff } from "./patch-summary.js";
import { truncateDiff } from "./patch-summary.js";
import { resolvePath } from "./path.js";

interface PatchLine {
  kind: " " | "+" | "-";
  text: string;
}

interface UpdateSection {
  anchor?: string;
  eof?: boolean;
  lines: PatchLine[];
}

type PatchOperation =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      moveTo?: string;
      path: string;
      sections: UpdateSection[];
    };

export interface PatchResult {
  changes: PatchChange[];
  /**
   * Stored after `changes` on purpose: a bounded copy of the details is cut in key order, so the
   * diffs absorb the cut and every change's metadata survives.
   */
  diffs: PatchDiff[];
  output: string;
}

/** Longest display diff stored per file, which keeps session files bounded. */
export const MAX_DIFF_CHARS = 24_000;
/** Largest regular file read solely to build a deletion diff. */
const MAX_DELETE_DIFF_SOURCE_BYTES = 1024 * 1024;
/**
 * Upper bound on the Myers diff work accepted for one update, as (old lines + new lines) times the
 * hunk lines. A full rewrite of a 6,000-line file costs about 2.5 s on the event loop; this keeps
 * display diffs near 100 ms while a small edit to a large file still gets its diff.
 */
const MAX_UPDATE_DIFF_WORK = 4_000_000;

const displayDiff = (before: string, after: string): string =>
  truncateDiff(generateDiffString(before, after).diff, MAX_DIFF_CHARS);

const lineCount = (content: string): number =>
  content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

/**
 * The patch's own hunk lines bound the edit distance the diff must search for. Context lines count
 * too: fuzzy matching lets a hunk's context replace file lines that differ only in whitespace.
 */
const updateDiffWork = (content: string, updated: string, sections: UpdateSection[]): number => {
  const hunkLines = sections.reduce((sum, section) => sum + section.lines.length, 0);
  return (lineCount(content) + lineCount(updated)) * hunkLines;
};

const sectionCounts = (sections: UpdateSection[]): NonNullable<PatchChange["lines"]> => {
  let added = 0;
  let removed = 0;
  for (const section of sections) {
    for (const line of section.lines) {
      if (line.kind === "+") added += 1;
      else if (line.kind === "-") removed += 1;
    }
  }
  return { added, removed };
};

const countLines = async (path: string): Promise<number> => {
  let newlines = 0;
  let last = 0x0a;
  for await (const chunk of createReadStream(path)) {
    // SAFETY: createReadStream without an encoding yields Buffers.
    const bytes = chunk as Buffer;
    for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) newlines += 1;
    last = bytes.at(-1) ?? last;
  }
  return last === 0x0a ? newlines : newlines + 1;
};

/**
 * Line count and, for files small enough to diff, the contents of a regular file about to be
 * deleted. FIFOs, sockets, devices, and symlinks are never read.
 */
const deletionSource = async (
  path: string,
): Promise<{ content?: string; removed: number } | undefined> => {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  if (info.size > MAX_DELETE_DIFF_SOURCE_BYTES) {
    // Display metadata is best-effort; an unreadable file must still be deleted.
    return await countLines(path)
      .then((removed) => ({ removed }))
      .catch(() => undefined);
  }
  const content = await readFile(path, "utf-8").catch(() => undefined);
  return content === undefined ? undefined : { content, removed: lineCount(content) };
};

const isOperationHeader = (line: string | undefined): boolean =>
  (line?.startsWith("*** Add File: ") ?? false) ||
  (line?.startsWith("*** Delete File: ") ?? false) ||
  (line?.startsWith("*** Update File: ") ?? false);

const getHeaderPath = (header: string, prefix: string): string => {
  const path = header.slice(prefix.length);
  if (path.length === 0) {
    throw new Error(`Patch path must not be empty: ${header}`);
  }
  return path;
};

const parsePatch = (patch: string): PatchOperation[] => {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    throw new Error("Patch must start with *** Begin Patch and end with *** End Patch");
  }

  const operations: PatchOperation[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index] ?? "";
    index += 1;

    if (header.startsWith("*** Add File: ")) {
      const path = getHeaderPath(header, "*** Add File: ");
      const content: string[] = [];
      while (index < lines.length && !isOperationHeader(lines[index])) {
        const line = lines[index] ?? "";
        if (!line.startsWith("+")) {
          throw new Error(`Invalid add-file line: ${line}`);
        }
        content.push(line.slice(1));
        index += 1;
      }
      if (content.length === 0) {
        throw new Error(`Add-file patch has no content: ${path}`);
      }
      operations.push({ kind: "add", lines: content, path });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      operations.push({
        kind: "delete",
        path: getHeaderPath(header, "*** Delete File: "),
      });
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const path = getHeaderPath(header, "*** Update File: ");
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = getHeaderPath(lines[index] ?? "", "*** Move to: ");
        index += 1;
      }

      const sections: UpdateSection[] = [];
      let section: UpdateSection | undefined;
      let reachedEndOfFile = false;
      while (index < lines.length && !isOperationHeader(lines[index])) {
        const line = lines[index] ?? "";
        index += 1;
        if (reachedEndOfFile) {
          throw new Error(`End-of-file marker must end the update: ${path}`);
        }
        if (line === "*** End of File") {
          if (!section) {
            throw new Error(`End-of-file marker has no patch hunk: ${path}`);
          }
          section.eof = true;
          reachedEndOfFile = true;
          continue;
        }
        if (line === "@@" || line.startsWith("@@ ")) {
          section = {
            anchor: line === "@@" ? undefined : line.slice(3),
            lines: [],
          };
          sections.push(section);
          continue;
        }
        const [kind] = line;
        if (kind !== " " && kind !== "+" && kind !== "-") {
          throw new Error(`Invalid update line: ${line}`);
        }
        if (section === undefined) {
          section = { lines: [] };
          sections.push(section);
        }
        section.lines.push({ kind, text: line.slice(1) });
      }
      if (sections.length === 0 && moveTo === undefined) {
        throw new Error(`Update-file patch has no changes: ${path}`);
      }
      operations.push({ kind: "update", moveTo, path, sections });
      continue;
    }

    throw new Error(`Invalid patch header: ${header}`);
  }

  if (operations.length === 0) {
    throw new Error("Patch must contain at least one file operation");
  }
  return operations;
};

const findSequence = (source: string[], expected: string[], start: number, eof = false): number => {
  if (expected.length === 0) {
    return eof ? source.length : start;
  }
  const matchesAt = (offset: number, trim: boolean) =>
    expected.every((line, index) => {
      const actual = source[offset + index];
      return trim ? actual?.trim() === line.trim() : actual === line;
    });

  const firstOffset = eof ? source.length - expected.length : start;
  const lastOffset = source.length - expected.length;
  if (firstOffset < start) {
    return -1;
  }
  for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
    if (matchesAt(offset, false)) {
      return offset;
    }
    if (eof) {
      break;
    }
  }
  for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
    if (matchesAt(offset, true)) {
      return offset;
    }
    if (eof) {
      break;
    }
  }
  return -1;
};

const findAnchor = (source: string[], anchor: string, start: number) =>
  source.findIndex((line, index) => index >= start && line.includes(anchor));

const applySections = (content: string, sections: UpdateSection[], filePath: string) => {
  const finalNewline = content.endsWith("\n");
  let source = content.length === 0 ? [] : content.replace(/\n$/u, "").split("\n");
  let cursor = 0;

  for (const section of sections) {
    if (section.anchor !== undefined) {
      const anchorIndex = findAnchor(source, section.anchor, cursor);
      if (anchorIndex === -1) {
        throw new Error(`Could not find patch context "${section.anchor}" in ${filePath}`);
      }
      cursor = anchorIndex + 1;
    }

    const oldLines = section.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    const newLines = section.lines.filter((line) => line.kind !== "-").map((line) => line.text);
    const offset = findSequence(source, oldLines, cursor, section.eof);
    if (offset === -1) {
      throw new Error(`Could not find patch hunk in ${filePath}`);
    }
    source = [...source.slice(0, offset), ...newLines, ...source.slice(offset + oldLines.length)];
    cursor = offset + newLines.length;
  }

  return `${source.join("\n")}${finalNewline && source.length > 0 ? "\n" : ""}`;
};

const withQueues = async <T>(paths: string[], operation: () => Promise<T>) => {
  const uniquePaths = [...new Set(paths)].toSorted();
  const enter = async (index: number): Promise<T> => {
    const path = uniquePaths[index];
    if (path === undefined) {
      return await operation();
    }
    return await withFileMutationQueue(path, async () => await enter(index + 1));
  };
  return await enter(0);
};

export const applyPatch = async (
  patch: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<PatchResult> => {
  const mutation = { started: false };
  const throwIfAborted = () => {
    if (!mutation.started && signal?.aborted === true) {
      throw new Error("Operation aborted");
    }
  };
  throwIfAborted();
  const operations = parsePatch(patch);
  const changes: PatchChange[] = [];
  const diffs: PatchDiff[] = [];

  for (const operation of operations) {
    throwIfAborted();
    const sourcePath = resolvePath(operation.path, cwd);
    if (operation.kind === "add") {
      const content = `${operation.lines.join("\n")}\n`;
      await withFileMutationQueue(sourcePath, async () => {
        throwIfAborted();
        await mkdir(nodePath.dirname(sourcePath), { recursive: true });
        throwIfAborted();
        mutation.started = true;
        await writeFile(sourcePath, content, { encoding: "utf-8", flag: "wx" });
      });
      changes.push({
        kind: "add",
        path: operation.path,
        changed: true,
        lines: { added: operation.lines.length, removed: 0 },
      });
      diffs.push({ diff: displayDiff("", content), index: changes.length - 1 });
      continue;
    }

    if (operation.kind === "delete") {
      const source = await withFileMutationQueue(sourcePath, async () => {
        throwIfAborted();
        const found = await deletionSource(sourcePath);
        throwIfAborted();
        mutation.started = true;
        await rm(sourcePath);
        return found;
      });
      const change: PatchChange = { kind: "delete", path: operation.path, changed: true };
      if (source !== undefined) {
        change.lines = { added: 0, removed: source.removed };
      }
      changes.push(change);
      if (source?.content !== undefined) {
        diffs.push({ diff: displayDiff(source.content, ""), index: changes.length - 1 });
      }
      continue;
    }

    const destinationPath =
      operation.moveTo === undefined ? sourcePath : resolvePath(operation.moveTo, cwd);
    const edit = await withQueues([sourcePath, destinationPath], async () => {
      throwIfAborted();
      let updated: string | undefined;
      let content: string | undefined;
      if (operation.sections.length > 0) {
        content = await readFile(sourcePath, "utf-8");
        throwIfAborted();
        updated = applySections(content, operation.sections, operation.path);
      }
      if (destinationPath !== sourcePath) {
        await mkdir(nodePath.dirname(destinationPath), { recursive: true });
        throwIfAborted();
      }
      mutation.started = true;
      if (updated !== undefined) {
        await writeFile(sourcePath, updated, "utf-8");
      }
      if (destinationPath !== sourcePath) {
        await rename(sourcePath, destinationPath);
      }
      if (content === undefined || updated === undefined || updated === content) {
        return { changed: false, diff: undefined };
      }
      return {
        changed: true,
        diff:
          updateDiffWork(content, updated, operation.sections) <= MAX_UPDATE_DIFF_WORK
            ? displayDiff(content, updated)
            : undefined,
      };
    });
    const lines = sectionCounts(operation.sections);
    changes.push(
      operation.moveTo === undefined
        ? { kind: "update", path: operation.path, changed: edit.changed, lines }
        : {
            kind: "update",
            from: operation.path,
            path: operation.moveTo,
            changed: edit.changed,
            lines,
          },
    );
    if (edit.diff !== undefined) {
      diffs.push({ diff: edit.diff, index: changes.length - 1 });
    }
  }

  return {
    changes,
    diffs,
    output: `Done!\n${changes.map((change) => `- ${change.path}`).join("\n")}`,
  };
};
