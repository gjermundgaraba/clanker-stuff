import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const CHECK_READMES_PATH = path.join(import.meta.dirname, "check-readmes.mjs");
const DESCRIPTION = "Adds a sample extension.";
const PACKAGE_NAME = "@clanker-stuff/sample";
const tempDirs: string[] = [];

const createFixture = (usage: string, finalNewline = true) => {
  const root = mkdtempSync(path.join(tmpdir(), "check-readmes-test-"));
  tempDirs.push(root);
  const packageDir = path.join(root, "sample");
  mkdirSync(packageDir);
  mkdirSync(path.join(root, "claude/plugins"), { recursive: true });
  mkdirSync(path.join(root, "codex/plugins"), { recursive: true });

  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "."\n  - "sample"\n'
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "clanker-stuff", private: true })
  );
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      description: DESCRIPTION,
      name: PACKAGE_NAME,
      pi: { extensions: ["./index.ts"] },
      private: false,
    })
  );
  writeFileSync(
    path.join(root, "README.md"),
    `# clanker stuff\n\nFixture repository.\n\n## Pi extensions\n\n| Extension | Description |\n| --- | --- |\n| [\`${PACKAGE_NAME}\`](sample) | ${DESCRIPTION} |\n\n## Claude Code plugins\n\nNone.\n\n## Codex plugins\n\nNone.\n\n## Development\n\nRequires Node.js 24 or newer. Run \`pnpm check:all\`.\n\n## License\n\n[MIT](LICENSE)\n`
  );

  const packageReadme = `# sample\n\n${DESCRIPTION}\n\n## Install\n\n\`\`\`bash\npi install npm:${PACKAGE_NAME}\n\`\`\`\n\n## Usage\n\n${usage}`;
  writeFileSync(
    path.join(packageDir, "README.md"),
    finalNewline ? `${packageReadme}\n` : packageReadme
  );

  return root;
};

const validateFixture = (root: string) =>
  spawnSync(process.execPath, [CHECK_READMES_PATH], {
    cwd: root,
    encoding: "utf8",
  });

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("README validation", () => {
  it.each([
    ["one prose line", "Run `/sample` to use the extension.", true],
    [
      "up to three bullets",
      "- Run `/sample`.\n- Choose an option.\n- Confirm the result.",
      true,
    ],
    ["prose without a final newline", "Run `/sample` to use it.", false],
  ])("accepts %s", (_label, usage, finalNewline) => {
    const result = validateFixture(createFixture(usage, finalNewline));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    ["a code block", "```text\nThis is a code block.\n```"],
    ["a numbered list", "1. Run the command."],
    ["mixed prose and bullets", "Run the command.\n- Confirm the result."],
  ])("rejects %s", (_label, usage) => {
    const result = validateFixture(createFixture(usage));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Usage must be one prose line or up to three short bullets."
    );
  });
});
