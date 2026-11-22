import { setTimeout as delay } from "node:timers/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { SENT, UNDELIVERED, MESSAGE_TYPE } from "../entries.js";
import extension from "../index.js";
import { letterSchema } from "../mailbox.js";

const launch = async (name: string | undefined) => {
  const h = await createAgentSessionHarness({
    extensionFactories: [extension],
    mode: "rpc",
  });

  if (name !== undefined) {
    h.session.setSessionName(name);
  }

  return h;
};

const quit = async (h: AgentSessionHarness) => {
  await h.session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  h.cleanup();
};

const until = async (condition: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the condition");
    }

    await delay(25);
  }
};

const letters = (h: AgentSessionHarness) =>
  h.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "custom_message" && entry.customType === MESSAGE_TYPE
        ? [JSON.stringify(entry.content)]
        : []
    );

const recorded = (h: AgentSessionHarness, customType: string) =>
  h.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === customType
        ? [entry.data]
        : []
    );

const userPrompts = (h: AgentSessionHarness) =>
  h.sessionManager
    .getEntries()
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "user"
    );

const toolResults = (h: AgentSessionHarness) =>
  h.messages().flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            isError: message.isError,
            text: JSON.stringify(message.content),
          },
        ]
      : []
  );

const settled = (h: AgentSessionHarness) =>
  h.getPendingResponseCount() === 0 && !h.session.isStreaming;

const send = (to: string, text: string, replyTo?: string) =>
  fauxAssistantMessage(
    fauxToolCall("peer_send", {
      to,
      text,
      ...(replyTo === undefined ? {} : { replyTo }),
    }),
    { stopReason: "toolUse" }
  );

const lastLetterId = (h: AgentSessionHarness): string => {
  const entry = h.sessionManager
    .getEntries()
    .findLast(
      (e) => e.type === "custom_message" && e.customType === MESSAGE_TYPE
    );

  if (entry?.type !== "custom_message") {
    throw new Error("No letter has arrived");
  }

  return Value.Parse(letterSchema, entry.details).id;
};

describe("two sessions talking by name", () => {
  it("delivers an answer to the asker as answering its question", async () => {
    const a = await launch("questioner");
    const b = await launch("expert");

    try {
      await delay(100);
      b.setResponses([
        () => send("questioner", "Approved.", lastLetterId(b)),
        fauxAssistantMessage("Answered."),
      ]);
      a.setResponses([
        send("expert", "Is the API change approved?"),
        fauxAssistantMessage("Asked; ending my turn."),
      ]);

      await a.prompt("Ask expert whether the API change is approved");

      a.setResponses([fauxAssistantMessage("Carrying on.")]);
      await until(() => letters(a).length === 1 && settled(a) && settled(b));

      expect(letters(a)[0]).toContain("answering your message");
    } finally {
      await quit(a);
      await quit(b);
    }
  });

  it("carries a question and its answer with one prompt, typed into the asker only", async () => {
    const a = await launch("asker");
    const b = await launch("answerer");

    try {
      await delay(100);
      b.setResponses([
        send("asker", "The secret is 42."),
        fauxAssistantMessage("Answered asker."),
      ]);
      a.setResponses([
        send("answerer", "What is the secret?"),
        fauxAssistantMessage("Asked; ending my turn."),
        fauxAssistantMessage("Got it: 42."),
      ]);

      await a.prompt("Ask answerer for the secret");
      await until(() => letters(a).length === 1 && settled(a) && settled(b));

      expect(letters(b)).toHaveLength(1);
      expect(letters(b)[0]).toContain("What is the secret?");
      expect(letters(b)[0]).toContain('peer_send with to \\"asker\\"');
      expect(letters(a)[0]).toContain("The secret is 42.");
      expect(recorded(a, SENT)).toStrictEqual([
        expect.objectContaining({
          to: "answerer",
          text: "What is the secret?",
        }),
      ]);
      expect(recorded(b, SENT)).toStrictEqual([
        expect.objectContaining({ to: "asker", text: "The secret is 42." }),
      ]);
      expect(userPrompts(a)).toHaveLength(1);
      expect(userPrompts(b)).toHaveLength(0);
    } finally {
      await quit(a);
      await quit(b);
    }
  });

  it("fails a message to a name nobody has as a tool error the sender sees", async () => {
    const a = await launch("lonely");

    try {
      await delay(100);
      a.setResponses([
        send("ghost", "hello?"),
        fauxAssistantMessage("It failed."),
      ]);
      await a.prompt("Message ghost");

      const results = toolResults(a);

      expect(results.map((result) => result.isError)).toStrictEqual([true]);
      expect(results[0]?.text).toContain(
        'Not delivered to \\"ghost\\": no live session has that name'
      );
      expect(recorded(a, UNDELIVERED)).toStrictEqual([
        {
          to: "ghost",
          text: "hello?",
          reason: "no live session has that name",
          live: [],
        },
      ]);
    } finally {
      await quit(a);
    }
  });

  it("refuses to send from a session with no name, since no reply could come back", async () => {
    const named = await launch("listener");
    const anonymous = await launch(undefined);

    try {
      await delay(100);
      anonymous.setResponses([
        send("listener", "hi"),
        fauxAssistantMessage("Could not."),
      ]);
      await anonymous.prompt("Say hi to listener");
      await delay(1200);

      expect(toolResults(anonymous)[0]?.isError).toBe(true);
      expect(toolResults(anonymous)[0]?.text).toContain("/name");
      expect(letters(named)).toHaveLength(0);
    } finally {
      await quit(named);
      await quit(anonymous);
    }
  });

  it("follows a rename, and frees the name when the session ends", async () => {
    const a = await launch("first-name");
    const b = await launch("sender");

    try {
      await delay(100);
      a.session.setSessionName("second-name");
      await delay(100);
      b.setResponses([
        send("first-name", "old"),
        send("second-name", "new"),
        fauxAssistantMessage("Done."),
      ]);
      a.setResponses([fauxAssistantMessage("Read it.")]);
      await b.prompt("Message both names");
      await until(() => letters(a).length === 1 && settled(a));

      expect(toolResults(b).map((result) => result.isError)).toStrictEqual([
        true,
        false,
      ]);
      expect(letters(a)[0]).toContain("new");
    } finally {
      await quit(a);
    }

    try {
      b.setResponses([
        send("second-name", "anyone?"),
        fauxAssistantMessage("Gone."),
      ]);
      await b.prompt("Message second-name again");

      expect(toolResults(b).at(-1)?.isError).toBe(true);
    } finally {
      await quit(b);
    }
  });
});
