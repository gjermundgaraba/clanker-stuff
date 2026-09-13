import { runQuestionPrompt } from "./dialog/controller.js";
import type { Question } from "./questions.js";
import { runQueuedPrompt } from "@clanker-stuff/pi-user-input/queue";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import { buildSummaryContent } from "./tool.js";

export const AsyncQuestionParameters = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          title: Type.String({
            description:
              "The complete question shown to the user, including any context needed to answer it.",
          }),
          options: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Suggested answers, in display order. Put the recommended answer first. The user can select one option or enter a free-text answer. Do not include an Other option; omit options for free text only.",
              minItems: 1,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export const AsyncMessageParameters = Type.Object(
  {
    message: Type.String({ description: "The concise question or update to send to the user." }),
  },
  { additionalProperties: false },
);

const clean = (text: string) => text.replaceAll(/[^\P{Cc}\n]/gu, "").trim();

export function parseAsyncQuestions(params: Static<typeof AsyncQuestionParameters>): Question[] {
  return params.questions.map(({ title, options }, index) => {
    const question = clean(title);
    if (!question) throw new Error("question titles must not be empty");
    const labels = options?.map(clean) ?? [];
    if (labels.some((label) => !label || label.toLowerCase() === "other")) {
      throw new Error("Use non-empty answer options; the UI supplies Other automatically");
    }
    if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
      throw new Error("Answer options must be distinct");
    }
    return {
      defaultOption: labels.length ? 0 : undefined,
      header: `Q${index + 1}`,
      question,
      multiSelect: false,
      options: [
        ...labels.map((label) => ({ kind: "option" as const, label })),
        { kind: "other", label: "Other" },
      ],
    };
  });
}

interface PendingQuestion {
  id: string;
  sessionId: string;
  questions: Question[];
  controller: AbortController;
  detach: () => void;
}

export function createAsyncInput(pi: ExtensionAPI) {
  const pending = new Map<string, PendingQuestion>();
  let currentContext: ExtensionContext | undefined;
  let generation = 0;
  let answering = false;

  const update = () => {
    const ctx = currentContext;
    if (!ctx) return;
    ctx.ui.setWidget(
      "async-questions",
      pending.size
        ? [
            `${pending.size} pending question${pending.size === 1 ? "" : "s"} · /answers to reply or dismiss`,
            ...[...pending.values()].flatMap(({ questions }) =>
              questions.map(({ question }) => question),
            ),
          ]
        : undefined,
    );
  };
  const remove = (item: PendingQuestion) => {
    if (pending.get(item.id) !== item) return;
    pending.delete(item.id);
    item.detach();
    update();
  };
  const dispose = () => {
    generation += 1;
    for (const item of pending.values()) {
      remove(item);
      item.controller.abort();
    }
    currentContext?.ui.setWidget("async-questions", undefined);
    currentContext = undefined;
  };

  return {
    dispose,
    async answer(ctx: ExtensionContext) {
      if (ctx.mode !== "tui") throw new Error("/answers requires interactive UI");
      if (answering) return;
      const candidates = [...pending.values()].filter(
        (item) => item.sessionId === ctx.sessionManager.getSessionId(),
      );
      if (!candidates.length) {
        ctx.ui.notify("No pending questions", "info");
        return;
      }
      const epoch = generation;
      let activeSignal = candidates[0].controller.signal;
      answering = true;
      try {
        let item = candidates[0];
        if (candidates.length > 1) {
          const labels = candidates.map(
            (candidate, index) => `${index + 1}. ${candidate.questions[0].question}`,
          );
          const selection = await runQueuedPrompt(ctx, item.controller.signal, async (signal) => {
            pi.events.emit("clanker:async-prompt", { active: true });
            try {
              return await ctx.ui.select("Answer pending questions", labels, { signal });
            } finally {
              pi.events.emit("clanker:async-prompt", { active: false });
            }
          });
          if (!selection) return;
          item = candidates[labels.indexOf(selection)];
        }
        if (epoch !== generation || !pending.has(item.id)) return;
        activeSignal = item.controller.signal;
        const flow = await runQuestionPrompt(
          ctx,
          item.questions,
          item.controller.signal,
          (active) => pi.events.emit("clanker:async-prompt", { active }),
        );
        if (
          epoch !== generation ||
          !pending.has(item.id) ||
          item.sessionId !== ctx.sessionManager.getSessionId()
        )
          return;
        remove(item);
        if (!flow.cancelled) {
          pi.sendUserMessage(buildSummaryContent(item.questions, flow.answers), {
            deliverAs: "steer",
          });
        }
      } catch (error) {
        if (epoch === generation && !activeSignal.aborted) throw error;
      } finally {
        answering = false;
      }
    },
    request(
      id: string,
      params: Static<typeof AsyncQuestionParameters>,
      signal: AbortSignal | undefined,
      ctx: ExtensionContext,
    ) {
      if (ctx.mode !== "tui") throw new Error("request_user_input_async requires interactive UI");
      signal?.throwIfAborted();
      const questions = parseAsyncQuestions(params);
      currentContext = ctx;
      const existing = pending.get(id);
      if (existing) {
        remove(existing);
        existing.controller.abort();
      }
      const controller = new AbortController();
      const item: PendingQuestion = {
        id,
        questions,
        controller,
        sessionId: ctx.sessionManager.getSessionId(),
        detach: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        remove(item);
        controller.abort(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      pending.set(id, item);
      update();
      return {
        content: [{ type: "text" as const, text: '{"accepted":true}' }],
        details: { accepted: true },
      };
    },
    message(params: Static<typeof AsyncMessageParameters>, ctx: ExtensionContext) {
      const message = clean(params.message);
      if (!message) throw new Error("message must not be empty");
      pi.appendEntry("async-attention", { message });
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      return {
        content: [{ type: "text" as const, text: '{"accepted":true}' }],
        details: { accepted: true },
      };
    },
  };
}

export const renderAttention: Parameters<ExtensionAPI["registerEntryRenderer"]>[1] = (
  entry,
  _options,
  theme,
) =>
  typeof entry.data === "object" &&
  entry.data !== null &&
  "message" in entry.data &&
  typeof entry.data.message === "string"
    ? new Markdown(entry.data.message, 0, 0, getMarkdownTheme())
    : new Text(theme.fg("accent", "Message for you"), 0, 0);
