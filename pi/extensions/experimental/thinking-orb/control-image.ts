/**
 * Marker-grid encoding for the pane-local coordinate texture.
 *
 * Every `CONTROL_PERIOD` pixels, two adjacent opaque pixels carry the pane-local
 * coordinate of that grid point: red 248 packs the X coordinate into green/blue
 * and red 249 packs the Y coordinate, both as 16-bit values normalized to
 * +/-`COORDINATE_RANGE` around the pane center. The Ghostty shader decodes the
 * same grid, so these constants must match `shaders/thinking-orb-overlay.glsl`.
 */

export const CONTROL_PERIOD = 8;
export const COORDINATE_RANGE = 8;

const encodeCoordinate = (coordinate: number): number => {
  const normalized =
    (Math.max(-COORDINATE_RANGE, Math.min(COORDINATE_RANGE, coordinate)) +
      COORDINATE_RANGE) /
    (COORDINATE_RANGE * 2);
  return Math.round(normalized * 65_535);
};

export interface ControlImageLayout {
  pixelHeight: number;
  pixelWidth: number;
  phaseX: number;
  phaseY: number;
}

/**
 * Renders the sparse RGBA coordinate texture. Only two of every
 * `CONTROL_PERIOD * CONTROL_PERIOD` pixels are opaque; the rest stay fully
 * transparent so the terminal underneath shows through.
 */
export const renderControlImage = (layout: ControlImageLayout): Buffer => {
  const buffer = Buffer.alloc(layout.pixelWidth * layout.pixelHeight * 4);
  const minimumSize = Math.min(layout.pixelWidth, layout.pixelHeight);

  for (let y = layout.phaseY; y < layout.pixelHeight; y += CONTROL_PERIOD) {
    const yCoordinate =
      ((layout.pixelHeight / 2 - (y + 0.5)) * 2) / minimumSize;
    const encodedY = encodeCoordinate(yCoordinate);

    for (
      let x = layout.phaseX;
      x + 1 < layout.pixelWidth;
      x += CONTROL_PERIOD
    ) {
      const xCoordinate = ((x + 0.5 - layout.pixelWidth / 2) * 2) / minimumSize;
      const encodedX = encodeCoordinate(xCoordinate);
      const offset = (y * layout.pixelWidth + x) * 4;

      buffer[offset] = 248;
      buffer[offset + 1] = Math.floor(encodedX / 256);
      buffer[offset + 2] = encodedX % 256;
      buffer[offset + 3] = 255;

      buffer[offset + 4] = 249;
      buffer[offset + 5] = Math.floor(encodedY / 256);
      buffer[offset + 6] = encodedY % 256;
      buffer[offset + 7] = 255;
    }
  }

  return buffer;
};
