import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";

import { debug } from "./log.js";

const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** A content block of a user turn, as Claude Code reads it in a prompt or a session. */
export type UserBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: (typeof IMAGE_MEDIA_TYPES)[number];
        data: string;
      };
    };

const imageBlock = (block: ImageContent): UserBlock => {
  const mediaType = IMAGE_MEDIA_TYPES.find((type) => type === block.mimeType);

  if (mediaType === undefined || block.data === "") {
    debug(
      `image block (${block.mimeType || "no mimeType"}) replaced by a marker`
    );

    return { type: "text", text: "[image]" };
  }

  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: block.data },
  };
};

/** Pi content as Claude's blocks: its text, its images, and a marker where the model
 *  must see something was there. An image Claude rejects (another media type, or no
 *  data) fails its request and every later one once it is in the session, so it becomes
 *  a marker, as does a block outside pi's types. The same for a prompt, a steer, a tool
 *  result and a rebuilt session. */
export const userBlocks = (content: UserMessage["content"]): UserBlock[] => {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }

  return content.flatMap((block): UserBlock[] => {
    const blockType: string = block.type;

    if (block.type === "text") {
      return block.text === "" ? [] : [{ type: "text", text: block.text }];
    }

    if (block.type === "image") {
      return [imageBlock(block)];
    }

    return [{ type: "text", text: `[${blockType}]` }];
  });
};
