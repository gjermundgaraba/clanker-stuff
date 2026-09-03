import { inflateSync, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { CONTROL_PERIOD, renderControlImage } from "../control-image.js";

const layout = {
  columns: 4,
  phaseX: 2,
  phaseY: 4,
  pixelHeight: 16,
  pixelWidth: 24,
  rows: 2,
};

describe(renderControlImage, () => {
  it("allocates one RGBA pixel per pane pixel", () => {
    const image = renderControlImage(layout);
    expect(image).toHaveLength(layout.pixelWidth * layout.pixelHeight * 4);
  });

  it("encodes marker pairs at the phase-aligned grid origin", () => {
    const image = renderControlImage(layout);
    const offset = (layout.phaseY * layout.pixelWidth + layout.phaseX) * 4;

    expect(image[offset]).toBe(248);
    expect(image[offset + 3]).toBe(255);
    expect(image[offset + 4]).toBe(249);
    expect(image[offset + 7]).toBe(255);
  });

  it("leaves pixels before the first marker transparent", () => {
    const image = renderControlImage(layout);
    const offset = (layout.phaseY * layout.pixelWidth + layout.phaseX) * 4;
    expect(image.subarray(0, offset)).toStrictEqual(Buffer.alloc(offset, 0));
  });

  it("spaces markers one control period apart", () => {
    const image = renderControlImage(layout);
    const offset = (layout.phaseY * layout.pixelWidth + layout.phaseX) * 4;
    const next = offset + CONTROL_PERIOD * 4;
    expect(image[next]).toBe(248);
    expect(image[next + 4]).toBe(249);
  });

  it("round-trips through zlib deflate", () => {
    const image = renderControlImage(layout);
    expect(inflateSync(deflateSync(image))).toStrictEqual(image);
  });
});
