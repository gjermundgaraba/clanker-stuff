import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";

it("ships the producer guide linked from the published README", () => {
  const root = mkdtempSync(path.join(tmpdir(), "border-protocol-pack-"));
  try {
    const tarball = path.join(root, "package.tgz");
    execFileSync("pnpm", ["pack", "--out", tarball], {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: "pipe",
    });
    execFileSync("tar", ["-xzf", tarball, "-C", root]);
    const packageRoot = path.join(root, "package");
    const readme = readFileSync(path.join(packageRoot, "README.md"), "utf8");
    const guide = readme.match(/\[producer guide\]\(([^)]+)\)/)?.[1];
    expect(guide).toBe("docs/producers.md");
    const contents = readFileSync(path.join(packageRoot, guide!), "utf8");
    expect(contents).toContain("createBorderStatusClient");
    expect(contents).toContain("## Wire lifecycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
