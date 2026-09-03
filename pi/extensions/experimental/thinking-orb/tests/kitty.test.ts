import { describe, expect, it } from "vitest";

import {
  CONTROL_IMAGE_ID,
  HEARTBEAT_IMAGE_ID,
  controlSequence,
  deleteSequence,
  heartbeatPayloads,
  heartbeatSequence,
  kittyChunks,
} from "../kitty.js";
import type { OverlayLayout } from "../layout.js";

const ESC = "\u001B";

const layout: OverlayLayout = {
  columns: 4,
  phaseX: 0,
  phaseY: 0,
  pixelHeight: 16,
  pixelWidth: 24,
  rows: 2,
};

describe(kittyChunks, () => {
  it("splits payloads larger than one chunk with continuation markers", () => {
    const chunks = kittyChunks("x".repeat(5000), "a=t,f=32,s=1,v=1,i=1,q=2");
    expect(chunks.split(`${ESC}_G`).length - 1).toBe(2);
    expect(chunks).toContain("q=2,m=1;");
    expect(chunks).toContain(`${ESC}_Gm=0;`);
  });

  it("sends short payloads as a single final chunk", () => {
    const chunks = kittyChunks("abc", "a=t,q=2");
    expect(chunks.split(`${ESC}_G`).length - 1).toBe(1);
    expect(chunks).toContain("a=t,q=2,m=0;abc");
  });
});

describe(controlSequence, () => {
  it("transmits the compressed texture with pane-local placement", () => {
    const sequence = controlSequence(layout);
    expect(sequence).toContain(`${ESC}[?2026h${ESC}7${ESC}[1;1H`);
    expect(sequence).toContain(
      `a=T,f=32,o=z,s=${layout.pixelWidth},v=${layout.pixelHeight},i=${CONTROL_IMAGE_ID},p=1,z=2,c=${layout.columns},r=${layout.rows},q=2,C=1`
    );
    expect(sequence).toContain(`${ESC}8${ESC}[?2026l`);
  });
});

describe("heartbeat", () => {
  it("alternates the transparent pixel's blue byte", () => {
    expect(heartbeatPayloads[0]).not.toBe(heartbeatPayloads[1]);
    expect(heartbeatPayloads[1]).toBe(
      Buffer.from([0, 0, 1, 0]).toString("base64")
    );
  });

  it("keeps each frame well under the byte budget", () => {
    for (const marker of [0, 1] as const) {
      const sequence = heartbeatSequence(marker);
      expect(sequence).toContain(
        `a=T,f=32,s=1,v=1,i=${HEARTBEAT_IMAGE_ID},p=2,z=3,q=2,C=1`
      );
      expect(Buffer.byteLength(sequence)).toBeLessThan(192);
    }
  });
});

describe(deleteSequence, () => {
  it("removes both images and restores the cursor", () => {
    const sequence = deleteSequence();
    expect(sequence).toContain(`a=d,d=I,i=${CONTROL_IMAGE_ID},q=2`);
    expect(sequence).toContain(`a=d,d=I,i=${HEARTBEAT_IMAGE_ID},q=2`);
    expect(sequence).toContain(`${ESC}[?25h`);
  });
});
