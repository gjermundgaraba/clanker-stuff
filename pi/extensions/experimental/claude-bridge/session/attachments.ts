// Carrying Claude Code's own attachments across a session rebuild.
//
// Claude Code expands an `@file` mention itself (pi passes `@` through untouched) and
// writes the expansion as a `type: "attachment"` record in its session file. Pi never
// sees it, so rebuilding a session from pi's history would drop the file while keeping
// the prompt text that referred to it.

import type { ImportAttachment, JsonlRecord, Message as SessionMessage } from "cc-session-io";

import { messageContentToText } from "./convert.js";
import type { LooseBlock } from "./convert.js";

// Only `@file` expansions are carried: the one thing pi genuinely never sees.
// `edited_text_file` also carries file content, but the edit is already in pi's history
// as a tool call and result, and it usually hangs off a tool-result record, which has no
// position in the ordinal scheme below. Everything else (`skill_listing`,
// `task_reminder`, ...) Claude Code rewrites every turn.
const CONTENT_BEARING = new Set(["file"]);

type Attachment = ImportAttachment["attachment"];

export interface CarriedAttachment {
  attachment: Attachment;
  /** Position of the parent among the session's text-bearing user records. */
  userOrdinal: number;
  /** That record's text, to verify the ordinal still points at the same turn. */
  parentText: string;
}

/** The text of a prompt's content, or undefined for tool results or an empty prompt. */
function promptText(content: string | readonly LooseBlock[]): string | undefined {
  if (typeof content !== "string" && content.some((block) => block.type === "tool_result")) {
    return undefined;
  }

  const text = messageContentToText(content);

  return text === "" ? undefined : text;
}

/** A session record's message content, decoded: records come from a file Claude Code
 *  writes, so cc-session-io's types describe what it expects rather than what it read. */
function decodeContent(value: unknown): string | LooseBlock[] | undefined {
  if (typeof value === "string") return value;

  if (!Array.isArray(value)) return undefined;

  const items: unknown[] = value;

  return items.flatMap((block): LooseBlock[] => {
    if (typeof block !== "object" || block === null) return [];

    if (!("type" in block) || typeof block.type !== "string") return [];

    return "text" in block && typeof block.text === "string"
      ? [{ type: block.type, text: block.text }]
      : [{ type: block.type }];
  });
}

interface DecodedRecord {
  uuid: string;
  parentUuid: string | null;
}

function decodeUserPrompt(record: JsonlRecord): (DecodedRecord & { text: string }) | undefined {
  if (record.type !== "user" || !("message" in record) || typeof record.uuid !== "string") {
    return undefined;
  }

  const { message } = record;

  if (typeof message !== "object" || message === null || !("content" in message)) return undefined;

  const content = decodeContent(message.content);
  const text = content === undefined ? undefined : promptText(content);

  return text === undefined ? undefined : { uuid: record.uuid, parentUuid: null, text };
}

function decodeAttachment(
  record: JsonlRecord,
): (DecodedRecord & { attachment: Attachment }) | undefined {
  if (
    record.type !== "attachment" ||
    !("attachment" in record) ||
    typeof record.uuid !== "string"
  ) {
    return undefined;
  }

  const { attachment, parentUuid } = record;

  if (typeof attachment !== "object" || attachment === null) return undefined;

  if (!("type" in attachment) || typeof attachment.type !== "string") return undefined;

  return {
    uuid: record.uuid,
    parentUuid: typeof parentUuid === "string" ? parentUuid : null,
    attachment: { ...attachment, type: attachment.type },
  };
}

/**
 * Content-bearing attachments in a session, each tagged with where its parent sits among
 * the text-bearing user records.
 *
 * The ordinal is the key rather than the record index because a rebuild does not
 * reproduce the old record list one-for-one (`importMessages` splits a message carrying
 * tool results into two records, and Claude Code appends records of its own), while the
 * sequence of user prompts is the same conversation either way. Attachments chain to one
 * another, so an ordinal is resolved up the parent links until it reaches a prompt.
 */
export function collectCarriedAttachments(records: readonly JsonlRecord[]): CarriedAttachment[] {
  const ordinalOf = new Map<string, number>();
  const textOf = new Map<string, string>();
  const carried: CarriedAttachment[] = [];
  let ordinal = 0;

  for (const record of records) {
    const prompt = decodeUserPrompt(record);

    if (prompt !== undefined) {
      ordinalOf.set(prompt.uuid, ordinal++);
      textOf.set(prompt.uuid, prompt.text);
      continue;
    }

    const decoded = decodeAttachment(record);
    const parent = decoded?.parentUuid;
    const inherited = parent == null ? undefined : ordinalOf.get(parent);
    const parentText = parent == null ? undefined : textOf.get(parent);

    // A run of attachments hangs off one prompt, and many parent to another attachment
    // rather than a message: inherit the ordinal so the whole run keys to the prompt
    // that caused it. Recorded for every attachment, since a content-bearing one can
    // chain off a `skill_listing` that is not carried.
    if (decoded === undefined || inherited === undefined || parentText === undefined) continue;

    ordinalOf.set(decoded.uuid, inherited);
    textOf.set(decoded.uuid, parentText);

    if (CONTENT_BEARING.has(decoded.attachment.type)) {
      carried.push({ attachment: decoded.attachment, userOrdinal: inherited, parentText });
    }
  }

  return carried;
}

export interface PlacedAttachments {
  attachments: ImportAttachment[];
  skipped: string[];
}

/**
 * Resolve each carried attachment to a position in the array about to be imported: the
 * messages after conversion and repair, the index space `importMessages` reads. Repair is
 * idempotent, so the indices stay valid through its second run.
 *
 * Deliberately conservative: attaching a file to the wrong turn tells the model it saw
 * something at a point it did not, which is worse than the loss this prevents. The
 * ordinal must land on a prompt whose text still matches; anything else is dropped.
 */
export function placeCarriedAttachments(
  carried: readonly CarriedAttachment[],
  messages: readonly SessionMessage[],
): PlacedAttachments {
  const prompts = messages.flatMap((message, index) => {
    const text = message.role === "user" ? promptText(message.content) : undefined;

    return text === undefined ? [] : [{ index, text }];
  });

  const attachments: ImportAttachment[] = [];
  const skipped: string[] = [];

  for (const item of carried) {
    const filename = item.attachment.filename;
    const name = typeof filename === "string" ? filename : item.attachment.type;
    const candidate = prompts[item.userOrdinal];

    if (candidate === undefined) {
      skipped.push(`${name}: prompt #${item.userOrdinal} is no longer in history`);
    } else if (candidate.text === item.parentText) {
      attachments.push({ afterIndex: candidate.index, attachment: item.attachment });
    } else {
      skipped.push(`${name}: prompt #${item.userOrdinal} changed`);
    }
  }

  return { attachments, skipped };
}
