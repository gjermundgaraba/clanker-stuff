import type { Model } from "@earendil-works/pi-ai";
import { getEncoding } from "js-tiktoken";
import type { SamplingStatus } from "@clanker-stuff/mcp/sampling-protocol";

let tokenizer: ReturnType<typeof getEncoding> | undefined;
const encoding = () => (tokenizer ??= getEncoding("o200k_base"));

/** Official tiktoken MODEL_PREFIX_TO_ENCODING maps gpt-5 to o200k_base.
 * Unknown model families are rejected rather than assigned an estimated tokenizer.
 */
export class CodexSamplingBound {
  readonly maxTokens: number;
  readonly status: SamplingStatus = {
    limitReached: false,
    usageComplete: false,
  };
  private readonly texts = new Map<number, string>();
  private readonly pending = new Map<number, string>();
  private readonly completed = new Set<number>();
  private verifiedLength = 0;

  constructor(
    readonly model: Model<string>,
    maxTokens: number,
  ) {
    if (
      model.provider !== "openai-codex" ||
      model.api !== "openai-codex-responses" ||
      !model.id.startsWith("gpt-5")
    ) {
      throw new Error(`No verified sampling output tokenizer for ${model.provider}/${model.id}`);
    }
    if (
      !Number.isSafeInteger(maxTokens) ||
      maxTokens <= 0 ||
      !Number.isSafeInteger(model.maxTokens) ||
      model.maxTokens <= 0
    ) {
      throw new Error("Sampling maxTokens must be a positive safe integer");
    }
    this.maxTokens = Math.min(maxTokens, model.maxTokens);
  }

  /** Revalidate exact final text after caller-side stop-sequence conversion. */
  boundText(text: string): string {
    const codec = encoding();
    const tokens = codec.encode(text, [], []);
    if (tokens.length <= this.maxTokens) return text;
    let length = this.maxTokens;
    let bounded = codec.decode(tokens.slice(0, length));
    while (bounded.endsWith("\uFFFD") || codec.encode(bounded, [], []).length > this.maxTokens) {
      bounded = codec.decode(tokens.slice(0, --length));
    }
    return bounded;
  }

  private text(index: number, text: string): string {
    const codec = encoding();
    const previous = this.texts.get(index) ?? "";
    const candidate = new Map(this.texts);
    candidate.set(index, text);
    const count = () => codec.encode([...candidate.values()].join(""), [], []).length;
    let tokens = count();
    if (tokens < this.maxTokens) {
      this.texts.set(index, text);
      this.verifiedLength += text.length - previous.length;
      return text;
    }
    this.status.limitReached = true;
    let bounded = text;
    const currentTokens = codec.encode(text, [], []);
    let length = currentTokens.length;
    while (tokens > this.maxTokens || bounded.endsWith("\uFFFD")) {
      if (length === 0) {
        // Interleaved authoritative replacements can change earlier BPE joins.
        // Retaining the previously verified content is always a valid bound.
        return previous;
      }
      length = Math.max(0, length - Math.max(1, tokens - this.maxTokens));
      bounded = codec.decode(currentTokens.slice(0, length));
      candidate.set(index, bounded);
      tokens = count();
    }
    this.texts.set(index, bounded);
    this.verifiedLength += bounded.length - previous.length;
    return bounded;
  }

  /** Filter reasoning and bound both deltas and authoritative completed items. */
  transform(event: Record<string, unknown>): Record<string, unknown> | undefined {
    const index = typeof event.output_index === "number" ? event.output_index : 0;
    if (typeof event.type === "string" && event.type.startsWith("response.reasoning"))
      return undefined;
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (!this.texts.has(index) || this.completed.has(index))
        throw new Error("Sampling text delta has no active message");
      if (typeof event.delta !== "string") throw new Error("Malformed sampling text delta");
      const previous = this.texts.get(index) ?? "";
      const pending = (this.pending.get(index) ?? "") + event.delta;
      // Only publish exactly verified text. Geometrically growing batches bound
      // aggregate tokenizer input for delta streams, without assuming that BPE
      // counts add across chunks. Small budgets still trigger early checks.
      if (pending.length < Math.max(Math.min(256, this.maxTokens), this.verifiedLength / 8)) {
        this.pending.set(index, pending);
        return undefined;
      }
      this.pending.delete(index);
      const next = this.text(index, previous + pending);
      if (!next.startsWith(previous)) {
        this.texts.set(index, previous);
        this.verifiedLength += previous.length - next.length;
        this.status.limitReached = true;
        return { ...event, delta: "" };
      }
      return { ...event, delta: next.slice(previous.length) };
    }
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const item = event.item;
      if (typeof item !== "object" || item === null || !("type" in item))
        throw new Error("Malformed sampling output item");
      if (item.type === "reasoning") return undefined;
      if (item.type !== "message")
        throw new Error(`Unsupported sampling output type: ${String(item.type)}`);
      if (this.completed.has(index)) throw new Error("Sampling message already completed");
      if (event.type === "response.output_item.added") {
        if (this.texts.has(index)) throw new Error("Duplicate sampling message index");
        this.texts.set(index, "");
      }
      if (event.type === "response.output_item.done") {
        this.pending.delete(index);
        this.completed.add(index);
        if (!("content" in item) || !Array.isArray(item.content))
          throw new Error("Malformed sampling message");
        const text = item.content
          .map((part: unknown) => {
            if (typeof part !== "object" || part === null || !("type" in part))
              throw new Error("Malformed sampling content");
            if (part.type === "output_text" && "text" in part && typeof part.text === "string")
              return part.text;
            if (part.type === "refusal" && "refusal" in part && typeof part.refusal === "string")
              return part.refusal;
            throw new Error(`Unsupported sampling content type: ${String(part.type)}`);
          })
          .join("");
        return {
          ...event,
          item: {
            ...item,
            content: [{ type: "output_text", text: this.text(index, text), annotations: [] }],
          },
        };
      }
    }
    return event;
  }
}
