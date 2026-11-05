import type { ImageContent, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { turnStart, userTurnBlocks } from "../turn.js";
import {
  assistant as assistantMessage,
  text,
  user,
} from "./session/messages.js";

const image = (data: string, mimeType = "image/png"): ImageContent => ({
  type: "image",
  data,
  mimeType,
});

const assistant = (value: string): Message => assistantMessage([text(value)]);

const pngBlock = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

describe("turnStart", () => {
  it("points at the first of the trailing user messages", () => {
    const messages = [
      user("old"),
      assistant("answer"),
      user("new"),
      user("preview"),
    ];

    expect(turnStart(messages)).toBe(2);
  });

  it("is the message count when the last message is not a user one", () => {
    expect(turnStart([user("old"), assistant("answer")])).toBe(2);
  });
});

describe("userTurnBlocks", () => {
  it("keeps the text and images of the trailing run of user messages", () => {
    const blocks = userTurnBlocks([
      user("earlier"),
      assistant("answer"),
      user([text("describe this"), image("aW1hZ2U=")]),
      user(""),
      user("(attachment preview: [#image 1])"),
    ]);

    expect(blocks).toStrictEqual([
      { type: "text", text: "describe this" },
      pngBlock("aW1hZ2U="),
      { type: "text", text: "(attachment preview: [#image 1])" },
    ]);
  });

  it("marks an image Claude cannot take instead of sending it", () => {
    expect(
      userTurnBlocks([
        user([text("look"), image(""), image("aW1hZ2U=", "image/tiff")]),
      ])
    ).toStrictEqual([
      { type: "text", text: "look" },
      { type: "text", text: "[image]" },
      { type: "text", text: "[image]" },
    ]);
  });

  it("has nothing for an empty or absent user turn", () => {
    expect(userTurnBlocks([user("")])).toBeUndefined();
    expect(userTurnBlocks([user("q"), assistant("a")])).toBeUndefined();
  });
});
