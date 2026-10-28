import { createHash } from "node:crypto";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const MAX_SKILL_FILES = 512;

export const MAX_SKILL_BYTES = 16 * 1024 * 1024;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

const SKILL_FILE = "SKILL.md";

const URI_CHARACTERS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]+$/u;

const ENCODED_SEPARATORS = /%(?:2f|5c|2e|00)/iu;

const URI = /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/(?<path>.+)$/u;

const SkillFileSchema = Type.Object({
  digest: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  uri: Type.String(),
});

const EntrySchema = Type.Object({
  frontmatter: Type.Record(Type.String(), Type.Unknown()),
  resources: Type.Union([Type.Literal("dynamic"), Type.Array(SkillFileSchema)]),
  uri: Type.String(),
});

export type SkillFile = Static<typeof SkillFileSchema>;

export interface SkillEntry {
  uri: string;
  root: string;
  rootSegments: string[];
  frontmatterJson: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
  files: SkillFile[];
  revision: string;
}

export interface DeclinedSkill {
  uri: string;
  reason: string;
}

export type DecodedEntry = { skill: SkillEntry } | { declined: DeclinedSkill };

const splitSkillUri = (
  uri: string
): { scheme: string; segments: string[] } | undefined => {
  const match = URI.exec(uri);
  const scheme = match?.groups?.["scheme"];
  const path = match?.groups?.["path"];

  if (scheme === undefined || path === undefined) {
    return undefined;
  }

  if (!URI_CHARACTERS.test(path) || ENCODED_SEPARATORS.test(path)) {
    return undefined;
  }

  const segments = path.split("/");

  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    return undefined;
  }

  return { scheme, segments };
};

const skillRevision = (files: readonly SkillFile[]): string =>
  createHash("sha256")
    .update(
      files
        .map((file) => `${file.uri}\n${file.digest}\n${String(file.size)}\n`)
        .toSorted()
        .join("")
    )
    .digest("hex");

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).toSorted(([a], [b]) => {
            if (a < b) {
              return -1;
            }

            return a > b ? 1 : 0;
          })
        )
      : nested
  );

const declined = (uri: string, reason: string): DecodedEntry => ({
  declined: { reason, uri },
});

const fileListProblem = (entry: {
  uri: string;
  root: string;
  files: SkillFile[];
}): string | undefined => {
  const seen = new Set<string>();

  for (const file of entry.files) {
    if (seen.has(file.uri)) {
      return `lists ${file.uri} twice`;
    }

    seen.add(file.uri);

    if (!DIGEST.test(file.digest)) {
      return `has a malformed digest for ${file.uri}`;
    }

    if (
      !file.uri.startsWith(`${entry.root}/`) ||
      splitSkillUri(file.uri) === undefined
    ) {
      return `lists ${file.uri}, which is not a file of the skill`;
    }
  }

  if (!seen.has(entry.uri)) {
    return "does not list its SKILL.md";
  }

  if (entry.files.length > MAX_SKILL_FILES) {
    return `has ${String(entry.files.length)} files, more than the limit of ${String(MAX_SKILL_FILES)}`;
  }

  const bytes = entry.files.reduce((total, file) => total + file.size, 0);

  if (bytes > MAX_SKILL_BYTES) {
    return `has ${String(bytes)} bytes, more than the limit of 16 MiB`;
  }

  return undefined;
};

export const decodeSkillEntry = (raw: unknown): DecodedEntry => {
  if (!Value.Check(EntrySchema, raw)) {
    const uri =
      typeof raw === "object" && raw !== null && "uri" in raw
        ? String(raw.uri)
        : "(no uri)";

    return declined(uri, "is not a valid skill entry");
  }

  const { frontmatter, uri } = raw;
  const { description, name } = frontmatter;

  if (typeof name !== "string" || typeof description !== "string") {
    return declined(uri, "has no name or description in its frontmatter");
  }

  const parts = splitSkillUri(uri);

  if (parts?.segments.at(-1) !== SKILL_FILE || parts.segments.at(-2) !== name) {
    return declined(uri, `does not end in /${name}/SKILL.md`);
  }

  if (raw.resources === "dynamic") {
    return declined(
      uri,
      "is generated dynamically, so its content cannot be verified"
    );
  }

  const root = uri.slice(0, -`/${SKILL_FILE}`.length);

  const files = raw.resources.map((file) => ({
    ...file,
    digest: file.digest.toLowerCase(),
  }));

  const problem = fileListProblem({ files, root, uri });

  if (problem !== undefined) {
    return declined(uri, problem);
  }

  return {
    skill: {
      description,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      files,
      frontmatterJson: canonicalJson(frontmatter),
      name,
      revision: skillRevision(files),
      root,
      rootSegments: [parts.scheme, ...parts.segments.slice(0, -1)],
      uri,
    },
  };
};
