import { createHash } from "node:crypto";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ReadResourceResult } from "@earendil-works/pi-mcp";

import { canonicalJson } from "./entry.js";
import type { SkillEntry, SkillFile } from "./entry.js";

/** Why bytes are not the file the entry lists, checking the raw length and then the SHA-256 digest. */
export const checkBytes = (
  bytes: Buffer,
  file: SkillFile
): string | undefined => {
  if (bytes.length !== file.size) {
    return `${file.uri} has ${String(bytes.length)} bytes, but the skill lists ${String(file.size)}`;
  }

  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  return digest === file.digest
    ? undefined
    : `${file.uri} does not match its digest`;
};

/**
 * The verified bytes of a `resources/read` result: the content item for exactly this URI, its text
 * as UTF-8 bytes or its decoded blob, checked against the file's entry.
 */
export const verifyFile = (
  result: ReadResourceResult,
  file: SkillFile
): { bytes: Buffer } | { failure: string } => {
  const item = result.contents.find((content) => content.uri === file.uri);

  if (!item) {
    return { failure: `the server returned no content for ${file.uri}` };
  }

  const bytes =
    "blob" in item
      ? Buffer.from(item.blob, "base64")
      : Buffer.from(item.text, "utf-8");

  const failure = checkBytes(bytes, file);

  return failure === undefined ? { bytes } : { failure };
};

/** Whether a fetched `SKILL.md` has exactly the frontmatter its entry promised, field by field. */
export const frontmatterMatches = (
  bytes: Buffer,
  entry: SkillEntry
): boolean => {
  try {
    const { frontmatter } = parseFrontmatter(bytes.toString("utf-8"));

    return canonicalJson(frontmatter) === entry.frontmatterJson;
  } catch {
    return false;
  }
};
