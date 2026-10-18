import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { INVALID_PARAMS, ProtocolError, ResourceTemplate } from "@modelcontextprotocol/server";
import type { McpServer, ReadResourceResult } from "@modelcontextprotocol/server";
import { parse } from "yaml";
import { z } from "zod";

const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

const SKILL_FILE = "SKILL.md";

const FRONTMATTER = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u;

const Frontmatter = z.looseObject({ description: z.string(), name: z.string() });

interface SkillFile {
  uri: string;
  digest: string;
  size: number;
}

interface SkillEntry {
  uri: string;
  frontmatter: z.infer<typeof Frontmatter>;
  resources: SkillFile[];
}

/** Every file below `dir`, as `/`-separated paths relative to it, in a stable order. */
const listFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .toSorted();

/**
 * The skills in a folder: every directory with a `SKILL.md`, served under `skill://<directory>/`.
 * A skill's files are everything below its directory, nested skills included. Digests are taken
 * now, from the bytes on disk.
 */
const discoverSkills = async (root: string): Promise<SkillEntry[]> => {
  const files = await listFiles(root);

  const skillDirs = files
    .filter((file) => path.posix.basename(file) === SKILL_FILE)
    .map((file) => path.posix.dirname(file));

  return await Promise.all(
    skillDirs.map(async (skillDir) => {
      const own = files.filter((file) => file.startsWith(`${skillDir}/`));

      const resources = await Promise.all(
        own.map(async (file) => {
          const bytes = await readFile(path.join(root, file));

          return {
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            size: bytes.length,
            uri: `skill://${file}`,
          };
        }),
      );

      const text = await readFile(path.join(root, skillDir, SKILL_FILE), "utf8");
      const yaml = FRONTMATTER.exec(text)?.groups?.yaml;

      return {
        frontmatter: Frontmatter.parse(yaml === undefined ? {} : parse(yaml)),
        resources,
        uri: `skill://${skillDir}/${SKILL_FILE}`,
      };
    }),
  );
};

const MIME_TYPES = new Map([
  [".md", "text/markdown"],
  [".sh", "text/x-shellscript"],
  [".txt", "text/plain"],
]);

/** A file below the skills folder, read from disk now. Text that is valid UTF-8 is sent as text. */
const readSkillFile = async (root: string, uri: string): Promise<ReadResourceResult> => {
  const relative = uri.slice("skill://".length);
  const file = path.resolve(root, relative);

  if (path.relative(root, file).startsWith(".."))
    throw new ProtocolError(INVALID_PARAMS, `Unknown resource: ${uri}`);

  const bytes = await readFile(file).catch(() => {
    throw new ProtocolError(INVALID_PARAMS, `Unknown resource: ${uri}`);
  });

  const mimeType = MIME_TYPES.get(path.extname(file)) ?? "application/octet-stream";

  try {
    return {
      contents: [{ mimeType, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), uri }],
    };
  } catch {
    return { contents: [{ blob: bytes.toString("base64"), mimeType, uri }] };
  }
};

/**
 * Serve the skills in a folder with the MCP Skills extension (SEP-2640): `skills/list`,
 * `skills/get`, and their files through `resources/read`. The folder is read on every request,
 * so edits show up without a restart. On the 2026-07-28 revision, results carry the cache fields
 * it requires.
 */
export const registerSkills = (
  server: McpServer,
  options: { dir: string; era: "legacy" | "modern" },
): void => {
  const root = path.resolve(options.dir);

  const complete =
    options.era === "modern" ? { cacheScope: "private", resultType: "complete", ttlMs: 0 } : {};

  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} } });
  server.registerResource(
    "skill-files",
    new ResourceTemplate("skill://{+path}", {
      list: async () => ({
        resources: (await discoverSkills(root)).map(({ frontmatter, uri }) => ({
          description: frontmatter.description,
          mimeType: "text/markdown",
          name: frontmatter.name,
          uri,
        })),
      }),
    }),
    { description: "Files of the skills this server serves" },
    async (uri) => await readSkillFile(root, uri.href),
  );
  server.server.setRequestHandler(
    "skills/list",
    { params: z.looseObject({ cursor: z.string().optional() }) },
    async () => ({
      ...complete,
      skills: await discoverSkills(root),
    }),
  );
  server.server.setRequestHandler(
    "skills/get",
    { params: z.looseObject({ uri: z.string() }) },
    async ({ uri }) => {
      const skill = (await discoverSkills(root)).find((candidate) => candidate.uri === uri);

      if (!skill) throw new ProtocolError(INVALID_PARAMS, `Unknown skill URI: ${uri}`);

      return { ...complete, skill };
    },
  );
};
