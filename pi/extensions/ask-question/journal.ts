import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { InteractionSchema } from "./interaction.js";
import { validateQuestionnaire } from "./request.js";
import type { Interaction } from "./interaction.js";

export const JOURNAL_TYPE = "questionnaire.snapshot";

const SnapshotSchema = Type.Object(
  { format: Type.Literal(1), interaction: InteractionSchema },
  { additionalProperties: false },
);

/** Disk verification is deliberately independent of Pi's in-memory append return. */
export function persistedEntries(ctx: Pick<ExtensionContext, "sessionManager">): SessionEntry[] {
  const file = ctx.sessionManager.getSessionFile();

  if (!file)
    throw new Error("Questionnaires require a file-backed session; --no-session is unsupported");
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(
      "Questionnaire persistence is not initialized or readable; complete an assistant turn in a file-backed session first",
      { cause },
    );
  }

  if (!text.endsWith("\n"))
    throw new Error("Incomplete session file; questionnaire persistence unavailable");

  const records: unknown[] = text
    .trimEnd()
    .split("\n")
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Session JSONL records remain opaque until the header check and byte-equivalent live-history verification below.
    .map((line): unknown => JSON.parse(line));

  const header = records.shift();

  if (
    !Value.Check(Type.Object({ type: Type.Literal("session"), id: Type.String() }), header) ||
    header.id !== ctx.sessionManager.getSessionId()
  )
    throw new Error("Session file identity mismatch");
  const memory = ctx.sessionManager.getEntries();

  if (
    memory.length !== records.length ||
    memory.some((e, i) => JSON.stringify(e) !== JSON.stringify(records[i]))
  )
    throw new Error(
      "Session file does not match live history; questionnaire persistence unavailable",
    );

  return memory;
}

export class Journal {
  private failed: Error | undefined;
  constructor(
    private readonly pi: Pick<ExtensionAPI, "appendEntry">,
    private readonly ctx: ExtensionContext,
  ) {}
  verify(): SessionEntry[] {
    if (this.failed) throw this.failed;

    return persistedEntries(this.ctx);
  }
  async checkpoint(item: Interaction, assertOwner: () => void): Promise<void> {
    const path = this.ctx.sessionManager.getSessionFile();

    if (!path) throw new Error("Questionnaires require a file-backed session");
    await withFileMutationQueue(resolve(path), async () => {
      assertOwner();
      this.verify();

      try {
        this.pi.appendEntry(JOURNAL_TYPE, { format: 1, interaction: structuredClone(item) });
        const entries = this.verify();
        const last = entries.at(-1);

        if (
          last?.type !== "custom" ||
          last.customType !== JOURNAL_TYPE ||
          !Value.Check(SnapshotSchema, last.data) ||
          JSON.stringify(last.data.interaction) !== JSON.stringify(item)
        )
          throw new Error("Questionnaire checkpoint was not persisted");
      } catch (cause) {
        this.failed = new Error(
          "Questionnaire checkpoint failed; stop using this session and reopen a verified session file before continuing",
          { cause },
        );
        throw this.failed;
      }
    });
  }
  replay(): Map<string, Interaction> {
    const state = new Map<string, Interaction>();
    // A new session or --no-session has no questionnaire state to recover.
    const branch = this.ctx.sessionManager.getBranch();

    if (!branch.some((e) => e.type === "custom" && e.customType === JOURNAL_TYPE)) return state;
    this.verify();

    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== JOURNAL_TYPE) continue;

      if (!Value.Check(SnapshotSchema, entry.data))
        throw new Error("Invalid questionnaire journal; recovery blocked");
      const item = structuredClone(entry.data.interaction);
      validateQuestionnaire(item.request);
      const prior = state.get(item.id);

      if (
        item.deliveries.length !== item.submissions.length ||
        item.submissions.some(
          (s, i) =>
            s.revision !== i + 1 ||
            s.parent_revision !== i ||
            item.deliveries[i]?.revision !== s.revision,
        ) ||
        (item.draft && item.draft.base_revision !== item.submissions.length) ||
        (prior &&
          (item.version <= prior.version ||
            JSON.stringify(item.request) !== JSON.stringify(prior.request) ||
            item.submissions.length < prior.submissions.length ||
            prior.submissions.some(
              (s, i) => JSON.stringify(s) !== JSON.stringify(item.submissions[i]),
            )))
      )
        throw new Error("Inconsistent questionnaire revision history; recovery blocked");
      item.paused = true;

      for (const delivery of item.deliveries)
        if (delivery.status === "handed_to_pi") delivery.status = "uncertain";
      state.set(item.id, item);
    }

    return state;
  }
}
