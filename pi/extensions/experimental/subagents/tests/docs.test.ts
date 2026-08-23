import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { codexContractFixture } from "../docs/fixtures/codex-contract.generated.js";

const docsDir = path.resolve(import.meta.dirname, "../docs");

describe("Codex parity documentation", () => {
  it("keeps parity rows structurally valid", async () => {
    const document = await readFile(
      path.join(docsDir, "codex-parity.md"),
      "utf-8"
    );
    const rows = document
      .split("\n")
      .filter((line) => /^\| [A-Z0-9]+-\d+ \|/u.test(line));
    const ids = rows.map((row) => row.split("|")[1]?.trim());
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of rows) {
      const cells = row.split("|").map((cell) => cell.trim());
      expect([
        "match",
        "partial",
        "different",
        "unsupported",
        "unknown",
      ]).toContain(cells[5]);
      expect(cells[7]).not.toBe("");
      expect(cells[8]).not.toBe("");
    }
  });

  it("keeps contract references discoverable at one pinned Codex commit", async () => {
    const names = [
      "codex-model-facing-contract.md",
      "codex-parity.md",
      "codex-reference.md",
      "protocols.md",
    ] as const;
    const documents = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          name,
          await readFile(path.join(docsDir, name), "utf-8"),
        ])
      )
    );
    const providerBaseline = await readFile(
      path.resolve(docsDir, "../../codex-provider/docs/codex-baseline.md"),
      "utf-8"
    );
    const { commit } = codexContractFixture;
    for (const link of [
      "codex-model-facing-contract.md",
      "codex-parity.md",
      "codex-reference.md",
    ]) {
      expect(documents["protocols.md"]).toContain(`(${link})`);
    }
    for (const link of ["codex-parity.md", "protocols.md"]) {
      expect(documents["codex-model-facing-contract.md"]).toContain(
        `(${link})`
      );
    }

    for (const name of [
      "codex-model-facing-contract.md",
      "codex-parity.md",
      "codex-reference.md",
    ] as const) {
      expect(documents[name]).toContain(commit);
      const linkedCommits = [
        ...documents[name].matchAll(
          /github\.com\/openai\/codex\/(?:blob|tree)\/(?<commit>[a-f0-9]{40})/gu
        ),
      ].map((match) => match.groups?.commit);
      expect(new Set(linkedCommits)).toStrictEqual(new Set([commit]));
    }
    expect(providerBaseline).toContain(commit);
  });
});
