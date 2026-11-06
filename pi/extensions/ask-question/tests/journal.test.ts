import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createInteraction, transition } from "../interaction.js";
import {
  REQUEST_TYPE,
  STATE_TYPE,
  recordRequest,
  recordState,
  replay,
} from "../journal.js";

const request = {
  wait: false,
  questions: [
    {
      id: "q",
      header: "Question",
      question: "Choose?",
      options: [{ id: "yes", label: "Yes" }],
    },
  ],
};

const session = () => {
  const sm = SessionManager.inMemory();

  return {
    sm,
    pi: {
      appendEntry: (type: string, data: unknown) => {
        sm.appendCustomEntry(type, data);
      },
    },
  };
};

describe("questionnaire journal", () => {
  it("stores the request once and restores the last state of open questionnaires", () => {
    const { sm, pi } = session();
    const created = createInteraction("q_open", request);
    recordRequest(pi, created);
    recordState(pi, created);

    const selected = transition(created, {
      type: "select",
      question: "q",
      option: "yes",
    });

    recordState(pi, selected);

    const answered = createInteraction("q_answered", request);
    recordRequest(pi, answered);
    recordState(pi, answered);
    recordState(
      pi,
      transition(
        transition(answered, { type: "select", question: "q", option: "yes" }),
        { type: "submit" }
      )
    );

    const types = sm
      .getBranch()
      .flatMap((entry) => (entry.type === "custom" ? [entry.customType] : []));

    expect(types).toStrictEqual([
      REQUEST_TYPE,
      STATE_TYPE,
      STATE_TYPE,
      REQUEST_TYPE,
      STATE_TYPE,
      STATE_TYPE,
    ]);

    const items = replay(sm.getBranch());

    expect([...items.keys()]).toStrictEqual(["q_open"]);
    expect(items.get("q_open")).toStrictEqual(selected);
  });

  it("skips unreadable entries and states without a request instead of blocking recovery", () => {
    const { sm, pi } = session();
    const item = createInteraction("q_kept", request);
    recordRequest(pi, item);
    recordState(pi, item);
    sm.appendCustomEntry(STATE_TYPE, { id: "q_kept", retired: true });
    sm.appendCustomEntry(REQUEST_TYPE, { id: "q_broken" });
    recordState(pi, createInteraction("q_orphan", request));

    const items = replay(sm.getBranch());

    expect([...items.keys()]).toStrictEqual(["q_kept"]);
    expect(items.get("q_kept")).toStrictEqual(item);
  });
});
