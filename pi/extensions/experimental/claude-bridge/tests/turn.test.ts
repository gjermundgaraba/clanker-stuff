import type { ImageContent, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { newAssistantOutput } from "../query/context.js";
import { extractUserPrompt, extractUserPromptBlocks, steerBlocks, turnStart } from "../turn.js";

import { testModel } from "./helpers.js";

const user = (content: UserMessage["content"]): UserMessage => ({
  role: "user",
  content,
  timestamp: 0,
});

const text = (value: string): TextContent => ({ type: "text", text: value });

const image = (data: string, mimeType = "image/png"): ImageContent => ({
  type: "image",
  data,
  mimeType,
});

const assistant = (value: string): Message => newAssistantOutput(testModel(), "stop", value);

const pngBlock = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

describe("turnStart", () => {
  it("points at the first of the trailing user messages", () => {
    const messages = [user("old"), assistant("answer"), user("new"), user("preview")];

    expect(turnStart(messages)).toBe(2);
  });

  it("is the message count when the last message is not a user one", () => {
    expect(turnStart([user("old"), assistant("answer")])).toBe(2);
  });
});

describe("extractUserPrompt", () => {
  it("joins the current turn's non-empty texts", () => {
    const messages = [
      user("earlier"),
      assistant("answer"),
      user([text("describe this"), image("aW1hZ2U=")]),
      user(""),
      user("(attachment preview)"),
    ];

    expect(extractUserPrompt(messages)).toBe("describe this\n(attachment preview)");
  });

  it("has no prompt when the last message is not a user one", () => {
    expect(extractUserPrompt([user("q"), assistant("a")])).toBeUndefined();
  });
});

describe("extractUserPromptBlocks", () => {
  it("keeps images and text from the trailing run of user messages", () => {
    const blocks = extractUserPromptBlocks([
      user([text("describe this"), image("aW1hZ2U=")]),
      user("(attachment preview: [#image 1])"),
    ]);

    expect(blocks).toEqual([
      { type: "text", text: "describe this" },
      pngBlock("aW1hZ2U="),
      { type: "text", text: "(attachment preview: [#image 1])" },
    ]);
  });

  it("does not reach past the current user turn", () => {
    const blocks = extractUserPromptBlocks([
      user([image("b2xk")]),
      assistant("done"),
      user("next turn"),
    ]);

    expect(blocks).toBeUndefined();
  });

  // Data-less image blocks occur in the wild.
  it("skips malformed image blocks instead of throwing", () => {
    const blocks = extractUserPromptBlocks([user([text("look"), image(""), image("aW1hZ2U=")])]);

    expect(blocks).toEqual([{ type: "text", text: "look" }, pngBlock("aW1hZ2U=")]);
  });

  it("skips images Claude cannot take and falls back to text without others", () => {
    const messages = [user([text("look"), image("aW1hZ2U=", "image/tiff")])];

    expect(extractUserPromptBlocks(messages)).toBeUndefined();
    expect(steerBlocks(messages)).toEqual([{ type: "text", text: "look" }]);
  });
});

describe("steerBlocks", () => {
  it("keeps a steer's image", () => {
    expect(steerBlocks([user([text("this one"), image("aW1hZ2U=")])])).toEqual([
      { type: "text", text: "this one" },
      pngBlock("aW1hZ2U="),
    ]);
  });

  it("has nothing to steer with for an empty or absent user turn", () => {
    expect(steerBlocks([user("")])).toBeUndefined();
    expect(steerBlocks([user("q"), assistant("a")])).toBeUndefined();
  });
});
