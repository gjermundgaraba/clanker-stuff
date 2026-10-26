import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { startPlannotatorCli } from "../cli.js";

let directory: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "plannotator-cli-")));
  vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { force: true, recursive: true });
});

const installPlannotator = async (body: string): Promise<void> => {
  await writeFile(path.join(directory, "plannotator"), `#!/usr/bin/env node\n${body}\n`, {
    mode: 0o755,
  });
};

it("starts Plannotator with its process contract, stderr lines, and output", async () => {
  await installPlannotator(`let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stderr.write("open");
  process.stderr.write("ing\\nsecond line\\nunterminated tail");
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    input,
    plannotatorCwd: process.env.PLANNOTATOR_CWD,
    origin: process.env.PLANNOTATOR_ORIGIN,
  }));
});`);
  const lines: string[] = [];

  const result = await startPlannotatorCli(["--git", "review target"], {
    cwd: directory,
    onStderrLine: (line) => lines.push(line),
    signal: new AbortController().signal,
    stdin: "review input",
  });

  expect(result).toStrictEqual({
    code: 0,
    signal: null,
    stdout: JSON.stringify({
      args: ["--git", "review target"],
      cwd: directory,
      input: "review input",
      plannotatorCwd: directory,
      origin: "pi",
    }),
  });
  expect(lines).toStrictEqual(["opening", "second line", "unterminated tail"]);
});

it("terminates the CLI on abort and completes once it closes", async () => {
  await installPlannotator(`process.stderr.write("ready\\n");
setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();

  const completion = startPlannotatorCli([], {
    cwd: directory,
    onStderrLine: (line) => {
      if (line === "ready") ready.resolve();
    },
    signal: controller.signal,
  });

  await ready.promise;
  controller.abort();

  await expect(completion).resolves.toStrictEqual({ code: null, signal: "SIGTERM", stdout: "" });
});

it("rejects arguments spawn refuses instead of throwing", async () => {
  await expect(
    startPlannotatorCli(["a\0b"], {
      cwd: directory,
      onStderrLine: () => {},
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
});
