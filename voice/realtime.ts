/* eslint-disable func-style, max-classes-per-file, no-use-before-define */

import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import { createCodexDesktopAttestationHeader } from "./device-attestation.js";
import { frameChunks } from "./stream.js";
import type { VoiceTrace } from "./trace.js";
import {
  buildContinuityItems,
  ContinuityTranscript,
  HandoffTranscript,
} from "./transcript.js";
import type { TranscriptEntry, TranscriptRole } from "./transcript.js";

const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls";
const SIDEBAND_URL = "wss://api.openai.com/v1/live";
const DEFAULT_RENEW_AFTER_MS = 55 * 60_000;
const RENEW_RETRY_MS = 20_000;
const CONTEXT_FRAME_BYTES = 500;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_DELEGATION_CHARS = 16_000;
const MAX_SDP_CHARS = 1_000_000;
const MAX_SEEN_DELEGATIONS = 1000;
const MAX_SIDEBAND_BYTES = 1_000_000;

export const VOICE_MODEL = "gpt-live-1-codex";
export const VOICE_NAME = "maple";
export const VOICE_INSTRUCTIONS = `## Your role

You are ChatGPT, the user-facing model in a realtime voice session.

Present as one unified ChatGPT assistant that can answer questions and work through the current pi coding-agent session, its workspace, and its tools. The user should not need to understand the internal separation between you and the backend execution model.

Never say that you are delegating to another model, handing work to pi, or waiting for an agent. Speak in the first person as ChatGPT.

## Introducing yourself

When asked who you are or what you can do, give a brief, natural introduction as ChatGPT. Present yourself as a voice-first way to help the user turn ideas and ongoing work into progress. Mention a few capabilities relevant to the conversation, such as talking through ideas, working with available session and workspace context, researching, writing, coding, or using connected tools. End by inviting the user to choose what to tackle.

## Spawn policy

Apply this policy before generating speech. First decide whether to answer from the context you already have or call \`SpawnThinking\`.

The specialized triggers below—session-context ambiguity, companion output, and ending the voice call—always require \`SpawnThinking\`, even when the request might otherwise seem directly answerable.

### Answer directly or spawn

Answer directly only when the user’s request is immediately answerable from the context you already have.

This includes ordinary conversation, brainstorming, follow-up questions, and interactive discussion where no additional information or action is needed.

For everything else, call \`SpawnThinking\`. This includes requests that require:

- current or missing information;
- search, inspection, or investigation;
- computer, application, terminal, or file interaction;
- code, repository, pull request, pi session, or other time-consuming, multi-step, or artifact-producing work that could block the live conversation;
- communication through an external service;
- changes to active or existing work;
- any action whose feasibility you are uncertain about.

Do not reject a request merely because you assume you lack the required tool, access, context, or capability. For any request requiring information or action beyond your current context, call \`SpawnThinking\` first. Report a limitation only after the backend returns a result establishing that the request cannot be completed.

Do not speculate about whether ChatGPT can perform the request. Spawn first and let the backend determine what is possible.

### Session-context ambiguity

Treat any plausible reference to the current pi session, workspace, terminal, or something the user can currently see as requiring backend context, even when the request is vague or underspecified.

This includes phrases such as “this,” “that,” “here,” “what I’ve been working on,” “the thing I’m looking at,” “what’s on my screen,” “this repository,” “this session,” “this message,” “this app,” or a question whose answer likely depends on current state that is not already in the voice conversation.

When a request could reasonably refer to current session, workspace, terminal, application, or screen state:

- call \`SpawnThinking\` instead of saying you do not have the context;
- do not ask the user to describe, paste, upload, or share what they are looking at;
- do not guess from prior voice context;
- let the backend inspect the available pi session and workspace context and determine what is known.

Prefer spawning when uncertain. Only answer directly when the referent is already unambiguous from the conversation itself.

### Companion output

The pi terminal shows rich output produced by ChatGPT while the voice conversation continues. Use it for information that is easier to understand, inspect, compare, retain, or open visually than to hear once.

Always call \`SpawnThinking\` when the user asks to:

- see, show, write, draft, list, display, chart, diagram, visualize, render, or put something on screen;
- create or review substantial written output, such as a report, specification, plan, proposal, analysis, or long explanation;
- receive something they can open, including a link, URL, source, page, document, pull request, or other resource.

These are not direct-answer cases, even when you already know the content or destination. Do not read long output aloud or speak and spell out URLs. Let the backend place the appropriate content in the pi terminal, then give only a brief spoken orientation or takeaway.

Also call \`SpawnThinking\` proactively when the conversation would materially benefit from a companion visual or written reference. Be especially alert during planning and architecture discussions; explanations of systems, flows, sequences, hierarchies, or relationships; comparisons involving several options or tradeoffs; and answers that would be cumbersome, lossy, or difficult to remember if delivered only through speech.

Do not spawn merely for decoration, to duplicate a short spoken answer, or when a routine conversational response is clearer by voice alone.

Backend Markdown, code, diagrams, links, and other detailed output may already be visible in the pi terminal. Treat it as your own output. Do not read displayed content aloud or duplicate it. Give only a brief orientation, implication, or question when useful.

### Ending the voice call

Treat both explicit requests and clear conversational sign-offs as intent to end the current voice call.

Explicit requests include asking to end, hang up, disconnect, close, or stop the voice call or voice session. Clear conversational sign-offs include phrases such as “bye,” “goodbye,” “talk to you later,” “see you later,” or “that’s all for now” when they naturally conclude the conversation.

When the user clearly intends to end the call, call \`SpawnThinking\` immediately so the backend can end it. Do not ask for confirmation.

Interpret sign-offs in context. Do not end the call for a bare “stop,” a request only to stop speaking, pause, hold on, or remain quiet, or a request to stop the current task. Do not end it for quoted, hypothetical, conditional, or negated references to ending a call. Polite acknowledgements such as “thanks,” “great,” “okay,” or “sounds good” are not sufficient by themselves.

### After spawning: acknowledge naturally, then remain silent

After every successful \`SpawnThinking\` call, treat the \`[thinking]\` marker as the cue to give exactly one brief, natural acknowledgement, then enter \`POST_SPAWN_SILENCE\`. This one receipt is allowed under later rules against filler; those rules must not suppress it.

Only the \`[thinking]\` marker begins a new acknowledgement. Backend \`[STATUS]\` or \`[COMPLETE]\` content belongs to the existing handoff, not a new request. Do not acknowledge it.

\`POST_SPAWN_SILENCE\` is \`SPAWN_MUTE\`. While it is active, do not stall, reassure, narrate waiting, or give another acknowledgement. Backend \`STATUS\` content may be spoken when it adds meaningful new information. Messages that only say work started, was dispatched, is running, or is still being checked remain silent.

While a handoff is unresolved, if the user repeats or substantially restates the same request without materially changing its scope, treat it as the existing request: do not call \`SpawnThinking\` again, do not acknowledge it again, and remain in \`POST_SPAWN_SILENCE\`. A correction, new constraint, materially changed scope, or separate request is new input and may be handled normally. After \`[COMPLETE]\`, a repeated request is new input.

If the user says stop, be quiet, or stop spoken updates, enter \`SPEECH_MUTE\` immediately. Produce no acknowledgement.

Keep the acknowledgement to one short sentence. Do not restate the full request, describe internal coordination, mention delegation or tooling, promise a particular outcome, or narrate how the work will be done.

## Lead with substance

Lead with the useful answer or next question. Avoid standalone acknowledgements and conversational fillers.

## Backend message handling

Every backend message begins with one of these uppercase channel prefixes:

\`[STATUS]\`
\`[COMPLETE]\`

Read and understand the leading prefix before interpreting the message. Treat it as routing metadata, not message content, and apply the corresponding handling rule below.

The prefix may arrive incrementally across streamed chunks. Wait until the closing \`]\` before deciding how to handle the message. Never speak the prefix, a partial prefix, channel names, delimiters, or other protocol syntax.

After recognizing the prefix, interpret everything following it as the backend message. Do not turn the arrival of a prefixed backend message into a new acknowledgement.

### \`STATUS\`

Surface backend \`STATUS\` content only when it adds new meaningful information.

Preserve the new finding, identified object, constraint, decision, or material progress. Rephrase it naturally and concisely without replacing its substance.

Do not produce an acknowledgement, reassurance, checking statement, action narration, or generic work-status update.

If there is no new meaningful information, remain silent.

Do not imply that unfinished work is complete.

If a \`COMPLETE\` message arrives in the same batch or immediately supersedes the update, use the \`STATUS\` message as context and do not speak a redundant progress message.

### \`COMPLETE\`

Communicate the message promptly as the final response for the current backend handoff.

A final message may contain a completed result, terminal limitation, blocker, or one question needed from the user. Rephrase it naturally while preserving its meaning; do not read backend boilerplate verbatim.

## Message priority and interruption

Use this priority order:

1. New user speech
2. \`COMPLETE\`
3. \`STATUS\`

If the user begins speaking, stop immediately and listen.

Do not lose an unspoken \`COMPLETE\` message because the user interrupted or changed topics. Retain it and communicate it at the next natural opportunity unless it becomes stale, superseded, or irrelevant.

When several backend messages arrive close together:

- read the complete batch before deciding what to say;
- if \`COMPLETE\` is present, produce one final response and use any \`STATUS\` content only as context;
- if \`STATUS\` is present without \`COMPLETE\`, surface at most one coherent progress update;
- prefer newer messages when messages in the same channel conflict.

## Filler is an error

Do not narrate activity, pending work, waiting, or reassurance. The acknowledgement must add conversational meaning; it cannot merely announce that work has started.

Do not ask the user to wait, thank them for waiting, promise to keep them updated, or fill silence because work is taking time.

Do not invent alternative wording to evade this rule. If there is no useful information to communicate, remain silent.

## Post-spawn acknowledgement voice

Keep the acknowledgement short, natural, and task-accurate.

On the \`[thinking]\` marker, acknowledge that the user’s request was heard; do not announce that work is starting. Match the acknowledgement to the user’s tone and the current turn. Mention a relevant object, constraint, or correction only when it makes the response naturally more grounded.

Do not default to checking or progress narration, generic reassurance, or a confirmation followed by first-person action or intent.

Across a session, vary the opening and the sentence structure. Changing only the task noun, action verb, or confirmation is not meaningful diversity.

## Speakable output

Write for natural speech.

Do not vocalize commands, paths, filenames, URLs, identifiers, hashes, ports, timestamps, exact test counts, or long numeric strings unless the user explicitly asks to hear the exact value.

When something has both a human-readable title or name and an identifier, use the title or name. For pull requests, use the pull request title rather than its number.

Rewrite backend responses rather than reading them verbatim. Remove wrapper roles, channel names, delimiters, reporting templates, implementation mechanics, and unnecessary verification details.

Wait for the user’s complete utterance. Do not backchannel while the user is speaking. If the user interrupts your output, stop immediately and listen.`;

export interface VoiceAuth {
  accessToken: string;
  accountId: string;
}

export interface DelegationBinding {
  callId: string;
  delegationId: string;
}

export interface VoiceDelegation {
  binding: DelegationBinding;
  input: string;
  transcriptDelta: TranscriptEntry[];
}

export type VoiceState = "closed" | "connecting" | "active" | "failed";

interface TranscriptEvent {
  delta: boolean;
  role: TranscriptRole;
  text: string;
}

interface RealtimeControlOptions {
  auth: VoiceAuth;
  callId: string;
  initialItems: Record<string, unknown>[];
  onDelegation: (event: Omit<VoiceDelegation, "transcriptDelta">) => void;
  onError: (error: Error) => void;
  onTranscript: (event: TranscriptEvent) => void;
  sessionId: string;
  threadId: string;
  trace?: VoiceTrace;
}

export interface VoiceSessionOptions {
  initialTranscript?: readonly TranscriptEntry[];
  onDelegation: (event: VoiceDelegation) => void;
  onError: (message: string) => void;
  onRenewDue: () => void;
  onState: (state: VoiceState) => void;
  resolveAuth: () => Promise<VoiceAuth>;
  threadId: string;
  trace?: VoiceTrace;
}

export class VoiceSession {
  private active: RealtimeControl | undefined;
  private creating: RealtimeControl | undefined;
  private generation = 0;
  private readonly continuity: ContinuityTranscript;
  private readonly handoffTranscript = new HandoffTranscript();
  private readonly inFlightDelegations = new Set<string>();
  private readonly options: VoiceSessionOptions;
  private pending: RealtimeControl | undefined;
  private renewDue = false;
  private renewalRequested = false;
  private renewRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sessionId = randomUUID();

  constructor(options: VoiceSessionOptions) {
    this.options = options;
    this.continuity = new ContinuityTranscript(options.initialTranscript);
  }

  async acceptOffer(offer: string): Promise<string> {
    this.closeCalls();
    const { generation } = this;
    this.options.onState("connecting");
    try {
      const control = await this.createControl(offer, generation);
      this.active = control;
      return control.answer;
    } catch (error) {
      const normalized = normalizeError(error);
      if (generation !== this.generation) {
        throw normalized;
      }
      this.options.onError(normalized.message);
      this.options.onState("failed");
      throw normalized;
    }
  }

  mediaReady(): void {
    if (!this.active) {
      return;
    }
    this.active.mediaReady();
    this.options.onState("active");
    this.armRenewTimer();
  }

  async renewOffer(offer: string): Promise<string> {
    if (!this.active) {
      throw new Error("There is no active voice call to renew.");
    }
    const { generation } = this;
    this.creating?.close();
    this.creating = undefined;
    this.pending?.close();
    this.pending = undefined;
    try {
      const control = await this.createControl(offer, generation);
      this.pending = control;
      return control.answer;
    } catch (error) {
      const normalized = normalizeError(error);
      if (generation !== this.generation) {
        throw normalized;
      }
      this.options.onError(
        `Replacement voice call failed: ${normalized.message}`
      );
      throw normalized;
    }
  }

  async commitRenew(): Promise<void> {
    if (!this.pending) {
      throw new Error("There is no replacement voice call to commit.");
    }
    if (this.inFlightDelegations.size > 0) {
      throw new Error("Voice renewal was deferred for an active handoff.");
    }
    const previous = this.active;
    this.active = this.pending;
    this.pending = undefined;
    this.active.mediaReady();
    previous?.close();
    this.renewDue = false;
    this.renewalRequested = false;
    this.options.onState("active");
    this.armRenewTimer();
  }

  abortRenew(): void {
    this.pending?.close();
    this.pending = undefined;
    this.renewalRequested = false;
    if (this.renewDue) {
      if (this.inFlightDelegations.size > 0) {
        return;
      }
      this.scheduleRenewRetry();
    }
  }

  recentTranscript(): TranscriptEntry[] {
    return this.continuity.recent();
  }

  takeTranscriptTail(): TranscriptEntry[] {
    return this.handoffTranscript.take();
  }

  sendStatus(binding: DelegationBinding, text: string): boolean {
    return this.sendHandoffMessage(binding, "commentary", text);
  }

  sendComplete(binding: DelegationBinding, text: string): boolean {
    const sent = this.sendHandoffMessage(binding, "speakable", text);
    if (sent) {
      this.inFlightDelegations.delete(bindingKey(binding));
      this.requestRenewalIfReady();
    }
    return sent;
  }

  endCall(): void {
    this.closeCalls();
    this.options.onState("closed");
  }

  dispose(): void {
    this.closeCalls();
    this.options.onState("closed");
  }

  private async createControl(
    offer: string,
    generation: number
  ): Promise<RealtimeControl & { answer: string }> {
    const auth = await this.options.resolveAuth();
    if (generation !== this.generation) {
      throw new Error("Voice call creation was cancelled.");
    }
    const callId = randomUUID();
    const control = new RealtimeControl({
      auth,
      callId,
      initialItems: buildContinuityItems(this.continuity.recent()),
      onDelegation: (event) => {
        if (control === this.active) {
          this.inFlightDelegations.add(bindingKey(event.binding));
          this.options.onDelegation({
            ...event,
            transcriptDelta: this.handoffTranscript.delegation(event.input),
          });
        }
      },
      onError: (error) => {
        if (control === this.pending) {
          this.pending = undefined;
          this.options.onError(
            `Replacement voice call failed: ${error.message}`
          );
          return;
        }
        if (control === this.active) {
          this.options.onError(error.message);
          this.options.onState("failed");
        }
      },
      onTranscript: (event) => {
        if (control !== this.active) {
          return;
        }
        if (event.delta) {
          this.handoffTranscript.addDelta(event.role, event.text);
        } else {
          this.handoffTranscript.complete(event.role, event.text);
          this.continuity.add(event.role, event.text);
        }
      },
      sessionId: this.sessionId,
      threadId: this.options.threadId,
      trace: this.options.trace,
    });
    this.creating = control;
    try {
      const answer = await control.createCall(offer);
      if (generation !== this.generation || this.creating !== control) {
        control.close();
        throw new Error("Voice call creation was cancelled.");
      }
      return Object.assign(control, { answer });
    } finally {
      if (this.creating === control) {
        this.creating = undefined;
      }
    }
  }

  private armRenewTimer(): void {
    this.clearRenewTimer();
    this.renewDue = false;
    this.renewTimer = setTimeout(() => {
      this.renewTimer = undefined;
      this.renewDue = true;
      this.requestRenewalIfReady();
    }, DEFAULT_RENEW_AFTER_MS);
    this.renewTimer.unref?.();
  }

  private clearRenewTimer(): void {
    if (this.renewTimer !== undefined) {
      clearTimeout(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  private requestRenewalIfReady(): void {
    if (
      !this.renewDue ||
      this.renewalRequested ||
      this.inFlightDelegations.size > 0 ||
      !this.active
    ) {
      return;
    }
    this.clearRenewRetryTimer();
    this.renewalRequested = true;
    this.options.onRenewDue();
  }

  private scheduleRenewRetry(): void {
    this.clearRenewRetryTimer();
    this.renewRetryTimer = setTimeout(() => {
      this.renewRetryTimer = undefined;
      this.requestRenewalIfReady();
    }, RENEW_RETRY_MS);
    this.renewRetryTimer.unref?.();
  }

  private clearRenewRetryTimer(): void {
    if (this.renewRetryTimer !== undefined) {
      clearTimeout(this.renewRetryTimer);
      this.renewRetryTimer = undefined;
    }
  }

  private sendHandoffMessage(
    binding: DelegationBinding,
    channel: "commentary" | "speakable",
    text: string
  ): boolean {
    const normalized = text.trim();
    if (
      !this.active ||
      binding.callId !== this.active.callId ||
      normalized.length === 0
    ) {
      return false;
    }
    return this.active.appendHandoffMessage(
      binding.delegationId,
      channel,
      normalized
    );
  }

  private closeCalls(): void {
    this.generation += 1;
    this.clearRenewTimer();
    this.clearRenewRetryTimer();
    this.creating?.close();
    this.active?.close();
    this.pending?.close();
    this.creating = undefined;
    this.active = undefined;
    this.pending = undefined;
    this.inFlightDelegations.clear();
    this.renewDue = false;
    this.renewalRequested = false;
  }
}

class RealtimeControl {
  readonly callId: string;
  private callAbort: AbortController | undefined;
  private closing = false;
  private readonly options: RealtimeControlOptions;
  private readonly seenDelegationIds = new Set<string>();
  private socket: WebSocket | undefined;
  private status: "closed" | "connecting" | "connected" | "active" | "failed" =
    "closed";

  constructor(options: RealtimeControlOptions) {
    this.options = options;
    this.callId = options.callId;
  }

  async createCall(offer: string): Promise<string> {
    if (!offer.trim() || offer.length > MAX_SDP_CHARS) {
      throw new Error("The WebRTC offer is missing or too large.");
    }
    if (this.status !== "closed") {
      throw new Error(`Cannot create a call while voice is ${this.status}.`);
    }

    this.status = "connecting";
    this.closing = false;
    const abort = new AbortController();
    this.callAbort = abort;
    try {
      const attestation = await createCodexDesktopAttestationHeader();
      this.assertCurrentCall(abort);
      const url = new URL(CALL_URL);
      url.searchParams.set("intent", "quicksilver");
      url.searchParams.set("architecture", "avas");
      const headers = chatgptHeaders(
        this.options.auth,
        {
          realtimeSessionId: this.callId,
          sessionId: this.options.sessionId,
          threadId: this.options.threadId,
        },
        attestation
      );
      const body = {
        sdp: offer,
        session: sessionConfig(this.options.initialItems),
      };
      this.options.trace?.("realtime.call.request", {
        body,
        method: "POST",
        url: url.toString(),
      });
      const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: { ...headers, "Content-Type": "application/json" },
        method: "POST",
        signal: abort.signal,
      });
      this.assertCurrentCall(abort);
      if (!response.ok) {
        const responseText = await response.text();
        const detail = responseText.slice(0, 2000);
        throw new Error(
          `Realtime call creation failed: HTTP ${response.status}${detail.length > 0 ? ` ${detail}` : ""}`
        );
      }

      const upstreamCallId = parseCallId(response.headers.get("location"));
      if (upstreamCallId === undefined) {
        throw new Error("Realtime call response did not include a call ID.");
      }
      const answer = await response.text();
      this.options.trace?.("realtime.call.response", {
        answer,
        headers: Object.fromEntries(response.headers),
        status: response.status,
      });
      this.assertCurrentCall(abort);
      const socket = new WebSocket(
        `${SIDEBAND_URL}/${encodeURIComponent(upstreamCallId)}`,
        { headers, maxPayload: MAX_SIDEBAND_BYTES }
      );
      this.socket = socket;
      await this.waitForSocket(socket);
      this.assertCurrentCall(abort);
      this.callAbort = undefined;
      this.status = "connected";
      return answer;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  mediaReady(): void {
    if (this.status !== "connected" || this.socket === undefined) {
      throw new Error(`Cannot activate voice while it is ${this.status}.`);
    }
    this.status = "active";
  }

  appendHandoffMessage(
    delegationId: string,
    channel: "commentary" | "speakable",
    text: string
  ): boolean {
    if (this.status !== "active") {
      return false;
    }
    for (const event of delegationContextEvents(delegationId, channel, text)) {
      this.send(event);
    }
    return true;
  }

  close(): void {
    if (this.status === "closed") {
      return;
    }
    this.closing = true;
    this.status = "closed";
    this.callAbort?.abort(new Error("Voice call creation was cancelled."));
    this.callAbort = undefined;
    const { socket } = this;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // The call is already closed.
    }
  }

  private async waitForSocket(socket: WebSocket): Promise<void> {
    const { promise, reject, resolve } = Promise.withResolvers<boolean>();
    let opened = false;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Realtime sideband connection timed out."));
    }, CONNECT_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) {
        opened = true;
        resolve(true);
      } else {
        reject(error);
      }
    };

    socket.on("open", () => {
      this.options.trace?.("realtime.sideband.open", {
        callId: this.callId,
      });
      finish();
    });
    socket.on("message", (data) => {
      const text = rawDataText(data);
      this.options.trace?.("realtime.sideband.received", {
        data: text,
      });
      this.handleMessage(text);
    });
    socket.on("error", (error) => {
      this.options.trace?.("realtime.sideband.error", {
        message: error.message,
      });
      if (opened) {
        this.fail(error);
      } else {
        finish(error);
      }
    });
    socket.on("close", () => {
      this.options.trace?.("realtime.sideband.close", {
        intentional: this.closing,
      });
      const error = new Error("Realtime sideband closed unexpectedly.");
      if (!opened) {
        finish(error);
      } else if (!this.closing) {
        this.fail(error);
      }
    });
    await promise;
  }

  private assertCurrentCall(abort: AbortController): void {
    if (
      abort.signal.aborted ||
      this.callAbort !== abort ||
      this.status !== "connecting"
    ) {
      throw abort.signal.reason instanceof Error
        ? abort.signal.reason
        : new Error("Voice call creation was cancelled.");
    }
  }

  private handleMessage(data: unknown): void {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(data));
      if (!isRecord(parsed)) {
        return;
      }
      event = parsed;
    } catch (error) {
      this.fail(error);
      return;
    }

    if (event.type === "error") {
      const message =
        isRecord(event.error) && typeof event.error.message === "string"
          ? event.error.message
          : "Unknown realtime protocol error.";
      this.fail(new Error(message));
      return;
    }

    const transcriptEvent = parseTranscriptEvent(event);
    if (transcriptEvent !== undefined) {
      this.options.onTranscript(transcriptEvent);
    }

    const delegation = parseDelegation(event);
    if (
      delegation === undefined ||
      !rememberDelegationId(this.seenDelegationIds, delegation.id)
    ) {
      return;
    }
    this.options.onDelegation({
      binding: {
        callId: this.callId,
        delegationId: delegation.id,
      },
      input: delegation.input,
    });
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket === undefined) {
      throw new Error("Realtime sideband is not connected.");
    }
    const data = JSON.stringify(event);
    this.options.trace?.("realtime.sideband.sent", { data });
    this.socket.send(data);
  }

  private fail(error: unknown): void {
    if (this.closing || this.status === "closed" || this.status === "failed") {
      return;
    }
    this.status = "failed";
    const normalized = normalizeError(error);
    this.callAbort?.abort(normalized);
    this.callAbort = undefined;
    this.options.onError(normalized);
    try {
      this.socket?.close();
    } catch {
      // The failing socket is already closed.
    }
    this.socket = undefined;
  }
}

export function parseTranscriptEvent(
  event: Record<string, unknown>
): TranscriptEvent | undefined {
  if (
    (event.type === "input_transcript.added" ||
      event.type === "output_transcript.added") &&
    isRecord(event.item) &&
    typeof event.item.text === "string"
  ) {
    return {
      delta: true,
      role: event.type === "input_transcript.added" ? "user" : "assistant",
      text: event.item.text,
    };
  }

  if (
    event.type === "turn.done" &&
    isRecord(event.turn) &&
    (event.turn.role === "user" || event.turn.role === "assistant") &&
    typeof event.turn.transcript === "string"
  ) {
    return {
      delta: false,
      role: event.turn.role,
      text: event.turn.transcript,
    };
  }

  return undefined;
}

function parseDelegation(
  event: Record<string, unknown>
): { id: string; input: string } | undefined {
  if (
    event.type !== "delegation.created" ||
    !isRecord(event.item) ||
    event.item.type !== "delegation" ||
    event.item.target !== "client" ||
    typeof event.item.id !== "string" ||
    event.item.id.length === 0 ||
    !Array.isArray(event.item.content)
  ) {
    return undefined;
  }

  const input = event.item.content
    .filter(
      (content): content is Record<string, unknown> =>
        isRecord(content) && content.type === "input_text"
    )
    .map((content) => (typeof content.text === "string" ? content.text : ""))
    .join("")
    .trim()
    .slice(0, MAX_DELEGATION_CHARS);
  return input ? { id: event.item.id, input } : undefined;
}

export function rememberDelegationId(
  seen: Set<string>,
  delegationId: string
): boolean {
  if (seen.has(delegationId)) {
    return false;
  }
  seen.add(delegationId);
  if (seen.size > MAX_SEEN_DELEGATIONS) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) {
      seen.delete(oldest);
    }
  }
  return true;
}

export function sessionConfig(
  initialItems: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    audio: { output: { voice: VOICE_NAME } },
    delegation: { type: "client" },
    ...(initialItems.length > 0 ? { initial_items: initialItems } : {}),
    instructions: VOICE_INSTRUCTIONS,
    model: VOICE_MODEL,
  };
}

export function delegationContextEvents(
  delegationId: string,
  channel: "commentary" | "speakable",
  text: string
): Record<string, unknown>[] {
  const tag = channel === "commentary" ? "STATUS" : "COMPLETE";
  return frameChunks(`[${tag}] ${text}`, CONTEXT_FRAME_BYTES).map((frame) => ({
    channel,
    content: [{ text: frame, type: "input_text" }],
    delegation_item_id: delegationId,
    type: "delegation.context.append",
  }));
}

function chatgptHeaders(
  auth: VoiceAuth,
  ids: {
    realtimeSessionId: string;
    sessionId: string;
    threadId: string;
  },
  attestation: string
): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    "openai-alpha": "quicksilver=v2",
    originator: "codex_desktop",
    "session-id": ids.sessionId,
    "thread-id": ids.threadId,
    "x-oai-attestation": attestation,
    "x-session-id": ids.realtimeSessionId,
  };
}

function parseCallId(location: string | null): string | undefined {
  if (location === null || location.length === 0) {
    return undefined;
  }
  const [withoutQuery] = location.split("?");
  return withoutQuery?.split("/").findLast(Boolean);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function bindingKey(binding: DelegationBinding): string {
  return `${binding.callId}\0${binding.delegationId}`;
}

function rawDataText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf-8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }
  return Buffer.from(data).toString("utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
