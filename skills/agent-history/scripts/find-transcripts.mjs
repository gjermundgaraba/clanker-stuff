#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

/** @param {...string} locations */
function existing(...locations) {
  return locations.filter((location) => fs.existsSync(location));
}

/** @param {string} root
 * @param {Set<string>} names
 * @param {number} maxDepth
 * @param {"file" | "directory"} type
 */
function findNamed(root, names, maxDepth, type) {
  if (!fs.existsSync(root)) return [];
  const matches = [];
  /** @type {Array<[string, number]>} */
  const pending = [[root, 0]];

  for (const [directory, depth] of pending) {
    /** @type {import("node:fs").Dirent[]} */
    let entries;

    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const location = path.join(directory, entry.name);

      if (
        names.has(entry.name) &&
        ((type === "file" && entry.isFile()) || (type === "directory" && entry.isDirectory()))
      ) {
        matches.push(location);
      }

      if (depth < maxDepth && entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push([location, depth + 1]);
      }
    }
  }

  return matches;
}

function opencodeLocations() {
  const configured = process.env.OPENCODE_DB;

  if (configured) return existing(path.resolve(configured));

  return existing(
    path.join(HOME, ".local", "share", "opencode", "opencode.db"),
    path.join(HOME, ".opencode", "opencode.db"),
  );
}

function cursorLocations() {
  const support = path.join(HOME, "Library", "Application Support", "Cursor", "User");

  return existing(
    path.join(support, "globalStorage", "state.vscdb"),
    path.join(HOME, ".cursor", "projects"),
  ).concat(findNamed(path.join(support, "workspaceStorage"), new Set(["state.vscdb"]), 2, "file"));
}

function copilotLocations() {
  const support = path.join(HOME, "Library", "Application Support");

  return ["Code", "Code - Insiders", "VSCodium", "Cursor"].flatMap((profile) =>
    findNamed(
      path.join(support, profile, "User", "workspaceStorage"),
      new Set(["chatSessions", "chatEditingSessions"]),
      3,
      "directory",
    ),
  );
}

/** @param {string} name */
const keyFor = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const tools = new Map(
  [
    {
      name: "Claude Code",
      detect: () =>
        existing(
          path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), "projects"),
        ),
    },
    {
      name: "Cline",
      detect: () =>
        existing(
          path.join(HOME, ".cline", "data", "db", "sessions.db"),
          path.join(HOME, ".cline", "data", "sessions"),
        ),
    },
    {
      name: "Codex",
      detect: () => {
        const root = process.env.CODEX_HOME || path.join(HOME, ".codex");

        return existing(path.join(root, "sessions"), path.join(root, "archived_sessions"));
      },
    },
    { name: "Cursor", detect: cursorLocations },
    {
      name: "Devin CLI",
      detect: () =>
        existing(
          path.join(HOME, ".local", "share", "devin", "cli", "sessions.db"),
          path.join(HOME, ".local", "share", "devin", "cli", "transcripts"),
        ),
    },
    { name: "GitHub Copilot", detect: copilotLocations },
    {
      name: "Grok Build",
      detect: () =>
        existing(path.join(process.env.GROK_HOME || path.join(HOME, ".grok"), "sessions")),
    },
    { name: "OpenCode", detect: opencodeLocations },
    {
      name: "Orca",
      detect: () =>
        existing(
          path.join(HOME, "Library", "Application Support", "orca", "orchestration.db"),
          path.join(HOME, "Library", "Application Support", "orca", "orca-data.json"),
        ),
    },
    { name: "Pi Local Agent", detect: () => existing(path.join(HOME, ".pi", "agent", "sessions")) },
    {
      name: "Sourcegraph Amp",
      detect: () => existing(path.join(HOME, ".cache", "amp", "logs", "threads")),
    },
    {
      name: "Warp CLI",
      detect: () =>
        existing(
          path.join(
            HOME,
            "Library",
            "Group Containers",
            "2BBY89MBSN.dev.warp",
            "Library",
            "Application Support",
            "dev.warp.Warp-Stable",
            "tui",
            "warp.sqlite",
          ),
        ),
    },
    {
      name: "Zed",
      detect: () =>
        existing(path.join(HOME, "Library", "Application Support", "Zed", "threads", "threads.db")),
    },
  ].map((tool) => [keyFor(tool.name), tool]),
);

/** @param {string[]} args */
function selectedTools(args) {
  const usage =
    "Usage: find-transcripts.mjs [--tool <name>]\nFind local transcript locations; omit --tool to search all supported agents.";

  if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) {
    console.log(`${usage}\nTools: ${[...tools.values()].map((tool) => tool.name).join(", ")}`);
    process.exit(0);
  }

  if (args.length === 0) return tools;
  const [flag, requested, ...extra] = args;

  if (
    flag !== "--tool" ||
    requested === undefined ||
    extra.length !== 0 ||
    requested.startsWith("-")
  ) {
    console.error(usage);
    process.exit(2);
  }

  const key = keyFor(requested);
  const tool = tools.get(key);

  if (tool === undefined) {
    console.error(`Unknown tool: ${requested}\n${usage}\nUse --help to list supported tools.`);
    process.exit(2);
  }

  return new Map([[key, tool]]);
}

// Validate the complete request before running any filesystem detector.
const selected = selectedTools(process.argv.slice(2));

const results = [];

for (const [, tool] of [...selected.entries()].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  const locations = [...new Set(tool.detect())].sort();

  if (locations.length) results.push({ tool: tool.name, locations });
}

console.log(JSON.stringify(results, null, 2));
