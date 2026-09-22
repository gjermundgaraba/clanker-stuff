import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

const docsDir = path.resolve(import.meta.dirname, "../docs");

describe("Codex parity documentation", () => {
  it("keeps parity rows structurally valid", async () => {
    const document = await readFile(path.join(docsDir, "codex-parity.md"), "utf-8");
    const rows = document.split("\n").filter((line) => /^\| [A-Z0-9]+-\d+ \|/u.test(line));
    const ids = rows.map((row) => row.split("|")[1]?.trim());
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    for (const row of rows) {
      const cells = row.split("|").map((cell) => cell.trim());
      expect(["match", "partial", "different", "unsupported", "unknown"]).toContain(cells[5]);
      expect(cells[7]).not.toBe("");
      expect(cells[8]).not.toBe("");
    }
  });
});
