import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const skill = path.resolve(import.meta.dirname, "..");

const roots: string[] = [];

const fixture = (markdown: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "description-links-"));
  roots.push(root);
  writeFileSync(path.join(root, "README.md"), markdown);

  return root;
};

const check = (root: string, folder = skill) =>
  spawnSync(process.execPath, [path.join(folder, "scripts/check-links.mjs"), root], {
    encoding: "utf8",
  });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub Markdown link checker", () => {
  it.each([
    ["inline code with underscore", "# `config_file`\n[Config](#config_file)\n"],
    ["formatting and punctuation", "# **Hello**, _world_!\n[Heading](#hello-world)\n"],
    [
      "Unicode and encoded fragments",
      "# Café 日本語\n[Heading](#caf%C3%A9-%E6%97%A5%E6%9C%AC%E8%AA%9E)\n",
    ],
    [
      "duplicate and colliding headings",
      "# Same\n# Same\n# Same-1\n# Same\n[a](#same) [b](#same-1) [c](#same-1-1) [d](#same-2)\n",
    ],
    [
      "setext heading and reference link",
      "Config_file\n===========\n[Config][target]\n\n[target]: #config_file\n",
    ],
    [
      "first reference definition wins",
      "# First\n[x][target]\n\n[target]: #first\n[target]: missing.md\n",
    ],
    [
      "links inside a GFM table",
      "# Table_target\n\n| Column |\n| --- |\n| [Target](#table_target) |\n",
    ],
    [
      "fenced code",
      "# Actual\n\n~~~~md\n# Fake\n[broken](not-present.md)\n~~~~\n\n[actual](#actual)\n",
    ],
    [
      "indented code and inline code",
      "# Actual\n\n    [broken](not-present.md)\n\n`[broken](not-present.md)`\n\n[actual](#actual)\n",
    ],
  ])("accepts %s", (_, markdown) => {
    const result = check(fixture(markdown));

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("0 broken");
  });

  it("resolves relative files, encoded paths, root-relative files and reference links", () => {
    const root = fixture(
      "[relative](nested/other%20file.md#other_anchor)\n[root](/nested/other%20file.md#other_anchor)\n[reference][target]\n\n[target]: nested/other%20file.md#other_anchor\n",
    );

    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "nested/other file.md"), "# `other_anchor`\n");

    expect(check(root)).toMatchObject({
      status: 0,
      stdout: "2 files, 3 relative links, 0 broken\n",
    });
  });

  it("reports missing anchors, missing files and invalid encodings with source lines", () => {
    const result = check(
      fixture("# Real\n[anchor](#missing)\n[file](missing.md)\n[encoding](%ZZ.md)\n"),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("README.md:2: missing anchor: #missing");
    expect(result.stdout).toContain("README.md:3: missing file: missing.md");
    expect(result.stdout).toContain("README.md:4: invalid URL encoding: %ZZ.md");
    expect(result.stdout).toContain("3 broken");
  });

  it("does not treat headings in a fenced code block as anchors", () => {
    const result = check(fixture("```md\n# Fake\n```\n[not an anchor](#fake)\n"));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing anchor: #fake");
  });

  it("checks inline and referenced image paths", () => {
    const root = fixture("![present](image.png) ![missing][image]\n\n[image]: missing.png\n");
    writeFileSync(path.join(root, "image.png"), "fixture");
    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing file: missing.png");
    expect(result.stdout).toContain("2 relative links, 1 broken");
  });

  it("does not fetch remote targets", () => {
    const result = check(
      fixture(
        "[web](https://invalid.example/) [mail](mailto:test@example.invalid) [protocol-relative](//invalid.example/README.md)\n",
      ),
    );

    expect(result).toMatchObject({ status: 0, stdout: "1 files, 0 relative links, 0 broken\n" });
  });

  it("executes from a whole-folder skill symlink", () => {
    const root = fixture("# `config_file`\n[Config](#config_file)\n");
    const installed = path.join(root, "installed-skill");
    symlinkSync(skill, installed, "dir");

    expect(check(root, installed)).toMatchObject({
      status: 0,
      stdout: "1 files, 1 relative links, 0 broken\n",
    });
  });

  it("returns a usage error for extra arguments", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(skill, "scripts/check-links.mjs"), ".", "extra"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});
