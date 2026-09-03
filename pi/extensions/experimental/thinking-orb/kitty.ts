/**
 * Kitty graphics protocol transmission for the overlay: chunked upload,
 * placement of the coordinate texture and the one-pixel heartbeat, image
 * deletion, and the zlib-compressed control payload.
 */

import { deflateSync } from "node:zlib";

import { allocateImageId } from "@earendil-works/pi-tui";

import { renderControlImage } from "./control-image.js";
import type { OverlayLayout } from "./layout.js";

const ESC = "\u001B";

export const CONTROL_IMAGE_ID = allocateImageId();
export const HEARTBEAT_IMAGE_ID = allocateImageId();

const CONTROL_PLACEMENT_ID = 1;
const HEARTBEAT_PLACEMENT_ID = 2;
const CONTROL_Z_INDEX = 2;
const HEARTBEAT_Z_INDEX = 3;
const CHUNK_SIZE = 4096;

export const kittyChunks = (payload: string, controls: string): string => {
  const chunks: string[] = [];

  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
    const first = offset === 0;
    const last = offset + CHUNK_SIZE >= payload.length;
    const chunkControls = first
      ? `${controls},m=${last ? 0 : 1}`
      : `m=${last ? 0 : 1}`;
    chunks.push(
      `${ESC}_G${chunkControls};${payload.slice(offset, offset + CHUNK_SIZE)}${ESC}\\`
    );
  }

  return chunks.join("");
};

/**
 * Transmits and places the full-pane coordinate texture. Wrapped in
 * synchronized output with save/restore so the terminal never shows the
 * intermediate state.
 */
export const controlSequence = (layout: OverlayLayout): string => {
  const payload = deflateSync(renderControlImage(layout), {
    level: 6,
  }).toString("base64");
  return [
    `${ESC}[?2026h${ESC}7${ESC}[1;1H`,
    kittyChunks(
      payload,
      `a=T,f=32,o=z,s=${layout.pixelWidth},v=${layout.pixelHeight},i=${CONTROL_IMAGE_ID},p=${CONTROL_PLACEMENT_ID},z=${CONTROL_Z_INDEX},c=${layout.columns},r=${layout.rows},q=2,C=1`
    ),
    `${ESC}8${ESC}[?2026l`,
  ].join("");
};

/**
 * The heartbeat is a transparent one-pixel image whose blue byte alternates
 * between 0 and 1. It is invisible but changes screen content, which forces a
 * repaint and therefore a fresh shader frame.
 */
export const heartbeatPayloads = [
  Buffer.from([0, 0, 0, 0]).toString("base64"),
  Buffer.from([0, 0, 1, 0]).toString("base64"),
] as const;

export const heartbeatSequence = (marker: 0 | 1): string =>
  [
    `${ESC}[?2026h${ESC}7${ESC}[1;1H`,
    kittyChunks(
      heartbeatPayloads[marker],
      `a=T,f=32,s=1,v=1,i=${HEARTBEAT_IMAGE_ID},p=${HEARTBEAT_PLACEMENT_ID},z=${HEARTBEAT_Z_INDEX},q=2,C=1`
    ),
    `${ESC}8${ESC}[?2026l`,
  ].join("");

export const deleteImagesSequence = (): string =>
  [
    `${ESC}_Ga=d,d=I,i=${CONTROL_IMAGE_ID},q=2${ESC}\\`,
    `${ESC}_Ga=d,d=I,i=${HEARTBEAT_IMAGE_ID},q=2${ESC}\\`,
  ].join("");

export const deleteSequence = (): string =>
  `${ESC}[?2026h${deleteImagesSequence()}${ESC}[?25h${ESC}[?2026l`;
