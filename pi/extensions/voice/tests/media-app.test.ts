import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("voice media app", () => {
  it("guards renewal requests and the final media swap with call identity", async () => {
    const source = await readFile(
      new URL("../media/app.js", import.meta.url),
      "utf-8"
    );

    expect(source).toMatch(
      /const originSession = session;[\s\S]*request\("renew_offer", offer, controller\.signal\)[\s\S]*request\("renew_commit", undefined, controller\.signal\)[\s\S]*requireCurrent\(\);[\s\S]*session = warmSession;/u
    );
    expect(source).toContain(
      'renewalController?.abort(new Error("Voice call closed."));'
    );
  });
});
