import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vite-plus/test";

const roots: string[] = [];

const createFixture = (
  svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>',
  assetPath = "view.svg",
  manifestSha = "abcdef1",
) => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-lens-report-"));
  roots.push(root);
  const graphPath = path.join(root, "graph.json");
  const manifestPath = path.join(root, "manifest.json");
  const outputPath = path.join(root, "report.html");
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "assets/view.svg"), svg);
  writeFileSync(
    graphPath,
    JSON.stringify({
      title: "Report <safe>",
      provenance: { head: { sha: "abcdef1" } },
      views: [{ id: "parent", children: [{ id: "detail", title: "Nested view" }] }],
      nodes: [{ id: "one", label: "Node <one>", delta: "added", files: [{ path: "src/one.ts" }] }],
      stats: { additions: 3, deletions: 1 },
    }),
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      graph: { headSha: manifestSha },
      assets: [{ path: assetPath, view: "detail", width: 100, height: 80 }],
    }),
  );

  return { graphPath, manifestPath, outputPath };
};

const render = (fixture: ReturnType<typeof createFixture>) =>
  spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "../scripts/build-report.mjs"),
      fixture.graphPath,
      fixture.manifestPath,
      fixture.outputPath,
    ],
    { encoding: "utf8" },
  );

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("embeds SVG, resolves nested views, and escapes displayed text", () => {
  const fixture = createFixture(undefined, "assets/view.svg");
  expect(render(fixture)).toMatchObject({ status: 0, stderr: "" });
  const html = readFileSync(fixture.outputPath, "utf8");
  expect(html).toContain("data:image/svg+xml;base64,");
  expect(html).toContain("Nested view");
  expect(html).toContain("Report &lt;safe&gt;");
  expect(html).toContain("Node &lt;one&gt;");
  expect(html).toContain("src/one.ts");
});

it("rejects assets outside the manifest directory", () => {
  const fixture = createFixture(undefined, "../outside.svg");
  const result = render(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("asset escapes");
  expect(existsSync(fixture.outputPath)).toBe(false);
});

it.each([
  "<svg><script>alert(1)</script></svg>",
  '<svg onload="alert(1)"></svg>',
  '<svg><a href="javascript:alert(1)"/></svg>',
])("rejects unsafe SVG: %s", (svg) => {
  const fixture = createFixture(svg, "assets/view.svg");
  const result = render(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unsafe SVG");
  expect(existsSync(fixture.outputPath)).toBe(false);
});

it("rejects a graph and manifest from different commits", () => {
  const fixture = createFixture(undefined, "assets/view.svg", "abcdef2");
  const result = render(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("different commits");
  expect(existsSync(fixture.outputPath)).toBe(false);
});
