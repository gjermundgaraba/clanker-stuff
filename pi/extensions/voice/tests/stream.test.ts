import { describe, expect, it } from "vite-plus/test";

import { frameChunks } from "../stream.js";

describe("voice context framing", () => {
  it("chunks without splitting multi-byte characters", () => {
    const chunks = frameChunks("aé🙂b", 4);

    expect(chunks).toStrictEqual(["aé", "🙂", "b"]);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 4)).toBeTruthy();
  });
});
