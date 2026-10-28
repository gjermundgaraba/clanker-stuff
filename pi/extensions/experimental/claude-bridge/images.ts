import type { ImageContent } from "@earendil-works/pi-ai";

import { debug } from "./log.js";

const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** What stands in for an image Claude cannot take, so the model sees one was there. */
export const IMAGE_MARKER = "[image]";

/** The image's media type when Claude accepts it. */
export const acceptedImageType = (
  block: ImageContent
): ImageMediaType | undefined => {
  const mediaType = IMAGE_MEDIA_TYPES.find((type) => type === block.mimeType);

  if (mediaType !== undefined && block.data !== "") {
    return mediaType;
  }

  debug(
    `image block (${block.mimeType || "no mimeType"}) replaced by a marker`
  );

  return undefined;
};
