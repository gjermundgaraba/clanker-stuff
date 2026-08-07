import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CliCompletion, CliStarter } from "../cli.js";
import { createTargetedReviewStarter } from "../review-launcher.js";

const exited = (): CliCompletion => ({
  code: 0,
  kind: "exited",
  stderr: "",
  stdout: "feedback",
});

describe("targeted review launcher", () => {
  it("switches to the requested base before opening the review", async () => {
    const child = Promise.withResolvers<CliCompletion>();
    let readyFile = "";
    const start = vi.fn<CliStarter>((_args, options) => {
      readyFile = options.env?.PLANNOTATOR_READY_FILE ?? "";
      writeFileSync(
        readyFile,
        `${JSON.stringify({
          isRemote: false,
          port: 19_432,
          url: "http://127.0.0.1:19432",
        })}\n`
      );
      return { cancel: vi.fn<() => void>(), completion: child.promise };
    });
    const order: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      order.push("switch");
      return Response.json({ base: "origin/main" });
    });
    const openUrl = vi.fn<() => Promise<void>>(async () => {
      order.push("open");
    });

    const review = createTargetedReviewStarter(start, {
      fetch: fetchImpl,
      openUrl,
    })(["review", "--base", "origin/main", "--local"], {
      cwd: "/work/project",
    });

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledOnce());
    const [request, requestInit] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = requestInit?.body;
    const body: unknown =
      typeof requestBody === "string" ? JSON.parse(requestBody) : requestBody;
    expect({
      args: start.mock.calls[0]?.[0],
      body,
      endpoint: request instanceof URL ? request.href : request,
      env: start.mock.calls[0]?.[1].env,
      order,
    }).toStrictEqual({
      args: ["review", "--git", "--local"],
      body: {
        base: "origin/main",
        diffType: "since-base",
        explicitBase: true,
      },
      endpoint: "http://127.0.0.1:19432/api/diff/switch",
      env: expect.objectContaining({
        PLANNOTATOR_READY_FILE: expect.any(String),
        PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      }),
      order: ["switch", "open"],
    });

    child.resolve(exited());
    await expect(review.completion).resolves.toStrictEqual(exited());
    expect(existsSync(path.dirname(readyFile))).toBeFalsy();
  });

  it.each([
    ["missing value", ["review", "--base"], "--base requires a Git ref"],
    [
      "pull request target",
      ["review", "--base", "main", "https://example.test/pull/1"],
      "--base cannot be combined with a pull request URL",
    ],
    [
      "GitButler mode",
      ["review", "--base", "main", "--gitbutler"],
      "--base is only supported for Git reviews",
    ],
  ])("rejects %s", (_label, args, message) => {
    const start = vi.fn<CliStarter>();
    expect(() =>
      createTargetedReviewStarter(start)(args, { cwd: "/work/project" })
    ).toThrow(message);
    expect(start).not.toHaveBeenCalled();
  });
});
