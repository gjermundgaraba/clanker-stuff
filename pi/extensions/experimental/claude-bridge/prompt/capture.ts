// What pi assembled for one agent, kept so the bridge can append only the portable
// parts after Claude Code's own preset prompt.
//
// Claude Code always runs its `claude_code` preset. Pi's assembled prompt reaches the
// provider as one string, so the parts that built it (context files, skills, custom
// prompt, append, extension sections) are recorded at pi's prompt boundaries, keyed by
// that exact string, and projected onto the preset per query. Pi's own harness text is
// never forwarded: Claude Code's subscription path reads a request carrying it as a
// third-party app.

import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";

import { debugLogPath } from "../log.js";
import { shared } from "../shared.js";
import { MCP_TOOL_PREFIX } from "../tools.js";

export interface PromptCaptureInput {
  custom?: string | undefined;
  append?: string | undefined;
  contextFiles: readonly { path: string; content: string }[];
  skills: readonly Skill[];
  /** Custom prompt sections from `systemPromptOptions.sections`, raw content keyed by
   *  name. pi renders each one as `<name>\ncontent\n</name>` after the built-ins. */
  sections?: Record<string, string> | undefined;
}

interface InheritedPrompt {
  start: number;
  end: number;
  parent: PromptCapture;
}

export interface PromptCapture extends PromptCaptureInput {
  assembledPrompt: string;
  /** Which bridge boundary last recorded this key (before_agent_start | agent_start | turn_start). */
  source?: string | undefined;
  /** Exact previously assembled prompts embedded in `custom`. */
  inherited: InheritedPrompt[];
}

export interface CaptureMatch {
  key: string;
  firstDivergent: number;
  source?: string | undefined;
}

/** The prompt that matched nothing, plus its closest known keys by shared prefix. The
 *  case that matters is pi rebuilding the prompt outside `before_agent_start`, which
 *  edits near the boundary, so a prefix match lands within a few characters of it. */
export interface PromptCaptureDiagnostic {
  systemPrompt: string;
  matches: CaptureMatch[];
}

/** Whether Claude Code can read skill files: through the bridged `read` tool or not at all. */
export type SkillReadTool = "mcp" | "none";

/**
 * Captures keyed by the fully assembled prompt pi sends to a provider.
 *
 * A sub-agent's systemPromptOverride embeds its parent's assembled prompt verbatim,
 * and pi exposes it as an ordinary custom prompt without provenance. Linking exact
 * prior keys recovers that inheritance graph without recognizing pi prose.
 */
export class PromptCaptures {
  private readonly captures = new Map<string, PromptCapture>();

  /** Pi rebuilds prompts when tools change, so only recent keys are kept. The bound is
   *  far above any plausible working set because evicting a live capture fails the
   *  turn; it exists to cap an extension that rebuilds the prompt every turn.
   *  Inheritance edges hold direct references and survive key eviction. */
  constructor(
    private readonly onDiagnose: (diagnostic: PromptCaptureDiagnostic) => void = () => {},
    private readonly limit = 256,
  ) {}

  record(systemPrompt: string, input: PromptCaptureInput, source?: string): void {
    const existing = this.captures.get(systemPrompt);
    const customChanged = existing?.custom !== input.custom;

    const capture: PromptCapture = existing ?? {
      assembledPrompt: systemPrompt,
      contextFiles: [],
      skills: [],
      inherited: [],
    };

    capture.custom = input.custom;
    capture.append = input.append;
    capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
    capture.skills = [...input.skills];
    // Copied: the caller's systemPromptOptions is live and later handlers mutate it.
    capture.sections = { ...input.sections };
    capture.source = source;

    if (existing === undefined || customChanged) {
      capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom);
    }

    // Mutated in place so descendants keep a live reference; re-inserted for recency.
    this.touch(systemPrompt, capture);
  }

  /** Exact lookup only. Callers serving a query want `resolveOrDerive`. */
  resolve(systemPrompt: string | undefined): PromptCapture | undefined {
    if (systemPrompt === undefined || systemPrompt === "") return undefined;

    const capture = this.captures.get(systemPrompt);

    if (capture !== undefined) this.touch(systemPrompt, capture);

    return capture;
  }

  get size(): number {
    return this.captures.size;
  }

  /** Recency is by use, not just by record: a parent records its prompt once and then
   *  only resolves it, so counting writes alone would age it out behind its sub-agents. */
  private touch(systemPrompt: string, capture: PromptCapture): void {
    this.captures.delete(systemPrompt);
    this.captures.set(systemPrompt, capture);

    // Trimmed here too: reviving an evicted node re-adds a key.
    for (const key of this.captures.keys()) {
      if (this.captures.size <= this.limit) break;
      this.captures.delete(key);
    }
  }

  /**
   * The capture to project for one query.
   *
   * An exact key is the normal case. A prompt that only *embeds* known prompts (an
   * extension wrapped what pi assembled after it was recorded) resolves to a transient
   * descendant over the whole prompt: projection swaps each embedded capture for its
   * portable parts and keeps the wrapper text around them, which belongs to whatever did
   * the wrapping. The descendant is not retained; its key is not ours to own.
   *
   * Throws when neither route accounts for the prompt. An empty capture instead would
   * send Claude Code none of the user's context files, skills or instructions and say so
   * only in a debug line. A failed turn is recoverable; one that ignored its policy is not.
   */
  resolveOrDerive(systemPrompt: string | undefined): PromptCapture | undefined {
    if (systemPrompt === undefined || systemPrompt === "") return undefined;

    const exact = this.captures.get(systemPrompt);

    if (exact !== undefined) {
      this.touch(systemPrompt, exact);

      return exact;
    }

    // Eviction drops a key while inheritance edges keep its node alive, and
    // findInheritedPrompts skips a node whose key is the prompt itself, so an evicted
    // exact match would otherwise derive nothing and throw.
    const revived = this.reachableCaptures().find((node) => node.assembledPrompt === systemPrompt);

    if (revived !== undefined) {
      this.touch(systemPrompt, revived);

      return revived;
    }

    // Inheritance must be tried before any looser adoption route: a child embedding its
    // parent's prompt contains every portable part of the parent, so an "adopt whatever
    // fits" rule placed first would re-key the parent under the child's prompt and drop
    // the child's wrapper text.
    const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);

    if (embedded.length === 0) throw this.unresolved(systemPrompt);

    // `custom` is the prompt itself and the edges keep their offsets, so projectCustom
    // substitutes the embedded captures in place and preserves every byte around them.
    return {
      assembledPrompt: systemPrompt,
      custom: systemPrompt,
      contextFiles: [],
      skills: [],
      inherited: embedded,
    };
  }

  private unresolved(systemPrompt: string): Error {
    const matches = this.closestKnown(systemPrompt);

    this.onDiagnose({ systemPrompt, matches });

    // A recorded key minus its tail is the signature of an extension-triggered idle turn
    // (sendMessage with triggerTurn), which skips before_agent_start and so renders
    // without that turn's extension additions.
    const truncated = matches.find(
      (match) =>
        match.firstDivergent === systemPrompt.length && match.key.length > systemPrompt.length,
    );

    if (truncated !== undefined) {
      return new Error(
        `prompt-capture: this ${systemPrompt.length}-char prompt is the ${truncated.key.length}-char capture recorded at ` +
          `${truncated.source ?? "an unknown boundary"} with its final ${truncated.key.length - systemPrompt.length} chars missing. ` +
          "That shape is an extension-triggered idle turn (sendMessage with triggerTurn), which skips before_agent_start, " +
          "so the prompt lacks that turn's extension additions. The turn fails; the next user-typed turn resolves normally. " +
          "Workaround: when idle, send a user message instead of triggerTurn.",
      );
    }

    const [closest] = matches;

    return new Error(
      `prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. ` +
        `Closest known match diverges at offset ${closest?.firstDivergent ?? "?"} ` +
        `(${closest?.key.length ?? 0}-char key${closest?.source === undefined ? "" : `, last recorded at ${closest.source}`}). ` +
        "Claude Code would receive none of this turn's context files, skills or custom instructions. " +
        "When the divergence sits at a section's opening tag, the capture and this prompt disagree about that section " +
        "(pi's mcp_servers, or one an extension added). " +
        "Otherwise an extension loaded after claude-bridge rewrote the system prompt from before_agent_start " +
        "(one that wraps it is fine, one that rebuilds or strips it leaves nothing to match), " +
        "or pi rebuilt the prompt outside before_agent_start (a late-registered tool or fresh resource discovery).",
    );
  }

  /** Longest shared-prefix matches, best first. */
  private closestKnown(systemPrompt: string): CaptureMatch[] {
    let shared = 0;
    const matches: CaptureMatch[] = [];

    for (const [key, capture] of this.captures) {
      const limit = Math.min(key.length, systemPrompt.length);
      let index = 0;

      while (index < limit && key.charCodeAt(index) === systemPrompt.charCodeAt(index)) index++;

      if (index < shared) continue;

      if (index > shared) {
        shared = index;
        matches.length = 0;
      }

      matches.push({ key, firstDivergent: index, source: capture.source });
    }

    return matches;
  }

  private findInheritedPrompts(
    systemPrompt: string,
    custom: string | undefined,
  ): InheritedPrompt[] {
    if (custom === undefined || custom === "") return [];

    const candidates: (InheritedPrompt & { length: number })[] = [];

    for (const parent of this.reachableCaptures()) {
      const key = parent.assembledPrompt;

      if (key === systemPrompt || key.length === 0) continue;

      for (
        let start = custom.indexOf(key);
        start !== -1;
        start = custom.indexOf(key, start + key.length)
      ) {
        candidates.push({ start, end: start + key.length, length: key.length, parent });
      }
    }

    // A grandchild contains its parent's key and the grandparent's nested inside it:
    // keep the longest exact non-overlapping matches.
    const selected: InheritedPrompt[] = [];

    for (const candidate of candidates.toSorted(
      (a, b) => b.length - a.length || a.start - b.start,
    )) {
      if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start)) {
        continue;
      }

      selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent });
    }

    return selected.toSorted((a, b) => a.start - b.start);
  }

  private reachableCaptures(): PromptCapture[] {
    const result: PromptCapture[] = [];
    const seen = new Set<PromptCapture>();

    const visit = (capture: PromptCapture): void => {
      if (seen.has(capture)) return;

      seen.add(capture);
      result.push(capture);

      for (const edge of capture.inherited) visit(edge.parent);
    };

    for (const capture of this.captures.values()) visit(capture);

    return result;
  }
}

/** The process-wide instance: isolated agents re-evaluate this module, and the serving
 *  instance's stream must resolve their captures. The first caller's `onDiagnose` wins.
 *  Never cleared: identical keys carry identical portable parts across sessions. */
export function sharedPromptCaptures(
  onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void,
): PromptCaptures {
  const state = shared();

  state.promptCaptures ??= new PromptCaptures(onDiagnose);

  return state.promptCaptures;
}

/** Pi's own preamble, the first section of every prompt pi renders without a custom
 *  prompt. Forwarding it makes Claude Code's subscription path read the request as a
 *  third-party app. */
export const PI_PREAMBLE = "You are an expert coding assistant operating inside pi";

/** Both doc paths from pi's documentation-routing line. Anthropic's subscription gate
 *  rejects a system prompt carrying both, while either alone passes. */
const ANTHROPIC_THIRD_PARTY_TRIGGERS = ["docs/custom-provider.md", "docs/packages.md"];

/** One piece of the append, named so a refusal can say where it found the text. */
interface PromptPart {
  label: string;
  text: string;
  /** The files a block was assembled from, so a refusal can name the one to edit. */
  files?: readonly { path: string; content: string }[];
}

/** Pi owns context-file discovery; Claude receives the same files, in the same order. */
export function formatProjectContext(
  contextFiles: readonly { path: string; content: string }[],
): string | undefined {
  if (contextFiles.length === 0) return undefined;

  const files = contextFiles.map(
    ({ path, content }) =>
      `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`,
  );

  return `<project_context>\n\nProject-specific instructions and guidelines:\n\n${files.join("")}</project_context>`;
}

export function renderSkillsBlock(
  skills: readonly Skill[],
  readTool: SkillReadTool,
): string | undefined {
  if (readTool === "none" || skills.length === 0) return undefined;

  const block = formatSkillsForPrompt([...skills]).trim();

  if (block === "") return undefined;

  // Claude Code knows pi's read tool only under its bridged MCP name.
  return block.replace(
    "Use the read tool to load a skill's file",
    `Use the read tool (${MCP_TOOL_PREFIX}read) to load a skill's file`,
  );
}

/** Skills visible through inherited prompts, ancestor first and once per file. */
export function collectPromptSkills(capture: PromptCapture): Skill[] {
  const result: Skill[] = [];
  const seenPaths = new Set<string>();
  const visited = new Set<PromptCapture>();
  const visiting = new Set<PromptCapture>();

  const visit = (node: PromptCapture): void => {
    if (visited.has(node)) return;

    if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");

    visiting.add(node);

    for (const edge of node.inherited) visit(edge.parent);

    for (const skill of node.skills) {
      if (skill.disableModelInvocation || seenPaths.has(skill.filePath)) continue;

      seenPaths.add(skill.filePath);
      result.push(skill);
    }

    visiting.delete(node);
    visited.add(node);
  };

  visit(capture);

  return result;
}

export function projectPromptCapture(
  capture: PromptCapture,
  skillReadTool: SkillReadTool,
): string | undefined {
  return projectCapture(capture, skillReadTool, new Set());
}

function projectCapture(
  capture: PromptCapture,
  skillReadTool: SkillReadTool,
  visiting: Set<PromptCapture>,
): string | undefined {
  if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance");

  visiting.add(capture);

  try {
    const inheritedSkillPaths = new Set(
      capture.inherited.flatMap((edge) =>
        collectPromptSkills(edge.parent).map((skill) => skill.filePath),
      ),
    );

    const ownSkillPaths = new Set<string>();

    const ownSkills = capture.skills.filter((skill) => {
      if (
        skill.disableModelInvocation ||
        inheritedSkillPaths.has(skill.filePath) ||
        ownSkillPaths.has(skill.filePath)
      ) {
        return false;
      }

      ownSkillPaths.add(skill.filePath);

      return true;
    });

    const parts: PromptPart[] = [];
    const context = formatProjectContext(capture.contextFiles);
    const skills = renderSkillsBlock(ownSkills, skillReadTool);
    const custom = projectCustom(capture, skillReadTool, visiting);

    if (context !== undefined) {
      parts.push({
        label: "the project context block",
        text: context,
        files: capture.contextFiles,
      });
    }

    if (skills !== undefined) parts.push({ label: "the skills block", text: skills });

    if (custom !== undefined && custom !== "") {
      parts.push({ label: "the custom prompt", text: custom });
    }

    if (capture.append !== undefined && capture.append !== "") {
      parts.push({ label: "the appended instructions", text: capture.append });
    }

    // pi renders custom sections last, after `cwd` (the one built-in with nothing
    // portable to forward), so they follow the append here.
    for (const [name, content] of Object.entries(capture.sections ?? {})) {
      if (content === "") continue;

      parts.push({ label: `the ${name} section`, text: `<${name}>\n${content}\n</${name}>` });
    }

    assertSendablePrompt(parts, capture);

    return parts.length > 0 ? parts.map((part) => part.text).join("\n\n") : undefined;
  } finally {
    visiting.delete(capture);
  }
}

function assertSendablePrompt(parts: readonly PromptPart[], capture: PromptCapture): void {
  const findings: string[] = [];

  for (const { label, text, files = [] } of parts) {
    const offset = preambleAtLineStart(text);

    if (offset !== -1) {
      findings.push(
        `pi's preamble ("${PI_PREAMBLE}") in ${label}, at offset ${offset} of ${text.length} chars`,
      );
    }

    // The pair must co-occur in one part; phrases split across parts are not detected.
    if (ANTHROPIC_THIRD_PARTY_TRIGGERS.every((trigger) => text.includes(trigger))) {
      const sources = files
        .filter(({ content }) =>
          ANTHROPIC_THIRD_PARTY_TRIGGERS.some((trigger) => content.includes(trigger)),
        )
        .map(({ path }) => path);

      findings.push(
        `${ANTHROPIC_THIRD_PARTY_TRIGGERS.join(" and ")} in ${label}` +
          (sources.length === 0 ? "" : ` (from ${sources.join(", ")})`),
      );
    }
  }

  if (findings.length === 0) return;

  throw new Error(
    [
      "prompt-capture: refusing to send this prompt. Claude Code's Anthropic path reads a request",
      "  carrying pi's harness, or the phrase pair its subscription gate rejects, as a third-party",
      "  app: it fails with 400 or is billed as extra usage.",
      ...findings.map((finding) => `  Found: ${finding}.`),
      `  Capture: ${capture.source ?? "unknown"}, ${capture.inherited.length} inherited capture(s) substituted.`,
      "  If it is your own text, reword or remove it. CLAUDE_BRIDGE_DEBUG=1 writes the full prompt to",
      `  ${debugLogPath()}.`,
    ].join("\n"),
  );
}

/** Offset of pi's preamble at the start of a line, or -1. Mid-line mentions are someone
 *  describing pi's prompt, not pi's prompt. */
function preambleAtLineStart(text: string): number {
  for (
    let offset = text.indexOf(PI_PREAMBLE);
    offset !== -1;
    offset = text.indexOf(PI_PREAMBLE, offset + PI_PREAMBLE.length)
  ) {
    if (offset === 0 || text[offset - 1] === "\n") return offset;
  }

  return -1;
}

function projectCustom(
  capture: PromptCapture,
  skillReadTool: SkillReadTool,
  visiting: Set<PromptCapture>,
): string | undefined {
  if (capture.custom === undefined || capture.inherited.length === 0) return capture.custom;

  let result = "";
  let cursor = 0;

  for (const edge of capture.inherited) {
    result += capture.custom.slice(cursor, edge.start);
    result += projectCapture(edge.parent, skillReadTool, visiting) ?? "";
    cursor = edge.end;
  }

  return result + capture.custom.slice(cursor);
}
