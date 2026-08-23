import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { PromptInput } from "../runtime.js";

const STRICT = { additionalProperties: false } as const;
export const V1InputItemSchema = Type.Union([
  Type.Object({ text: Type.String(), type: Type.Literal("text") }, STRICT),
  Type.Object(
    { image_url: Type.String(), type: Type.Literal("image") },
    STRICT
  ),
  Type.Object(
    { path: Type.String({ minLength: 1 }), type: Type.Literal("local_image") },
    STRICT
  ),
  Type.Object(
    {
      name: Type.String({ minLength: 1 }),
      path: Type.String({ minLength: 1 }),
      type: Type.Literal("skill"),
    },
    STRICT
  ),
]);
export type V1InputItem = Static<typeof V1InputItemSchema>;

const DATA_IMAGE =
  /^data:(?<mimeType>image\/(?:gif|jpeg|png|webp));base64,(?<data>[a-z0-9+/=\s]+)$/iu;
const IMAGE_MIME = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const localImage = async (cwd: string, file: string): Promise<ImageContent> => {
  const root = await realpath(cwd);
  const target = await realpath(path.resolve(cwd, file));
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("local_image must resolve to a file inside the cwd");
  }
  const mimeType = IMAGE_MIME.get(path.extname(target).toLowerCase());
  if (mimeType === undefined) {
    throw new Error("local_image must be PNG, JPEG, GIF, or WebP");
  }
  const data = await readFile(target);
  return {
    data: data.toString("base64"),
    mimeType,
    type: "image",
  };
};

const skillText = async (
  item: Extract<V1InputItem, { type: "skill" }>,
  skills: readonly Skill[]
): Promise<string> => {
  const skill = skills.find(
    (candidate) =>
      candidate.name === item.name &&
      path.resolve(candidate.filePath) === path.resolve(item.path)
  );
  if (skill === undefined) {
    throw new Error(`Unknown skill: ${item.name}`);
  }
  const body = stripFrontmatter(await readFile(skill.filePath, "utf-8")).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
};

export const prepareInput = async (
  message: string | undefined,
  items: readonly V1InputItem[] | undefined,
  cwd: string,
  skills: readonly Skill[],
  trusted: boolean
): Promise<PromptInput> => {
  if ((message === undefined) === (items === undefined)) {
    throw new Error("Provide exactly one of message or items");
  }
  if (message !== undefined) {
    if (message.trim() === "") {
      throw new Error("message must not be blank");
    }
    return { text: message };
  }

  const prepared = await Promise.all(
    (items ?? []).map(async (item): Promise<string | ImageContent> => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "skill") {
        return await skillText(item, skills);
      }
      if (item.type === "local_image") {
        if (!trusted) {
          throw new Error("local_image requires a trusted project");
        }
        return await localImage(cwd, item.path);
      }
      const match = DATA_IMAGE.exec(item.image_url);
      if (!match?.groups) {
        throw new Error(
          "image_url must be a base64 PNG, JPEG, GIF, or WebP data URL"
        );
      }
      return {
        data: match.groups.data.replaceAll(/\s/gu, ""),
        mimeType: match.groups.mimeType.toLowerCase(),
        type: "image",
      };
    })
  );
  const text = prepared.filter(
    (item): item is string => typeof item === "string"
  );
  const images = prepared.filter(
    (item): item is ImageContent => typeof item !== "string"
  );
  if (text.every((value) => value.trim() === "") && images.length === 0) {
    throw new Error("items must contain text, an image, or a skill");
  }
  return {
    ...(images.length === 0 ? {} : { images }),
    text: text.join("\n\n") || "Review the attached image input.",
  };
};
