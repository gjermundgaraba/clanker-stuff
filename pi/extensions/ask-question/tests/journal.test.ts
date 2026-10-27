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
  it("stores the request once and restores the last state joined to it", () => {
    const { sm, pi } = session();
    const created = createInteraction("q_test", request, "call", "async");
    recordRequest(pi, created);
    recordState(pi, created);

    const selected = transition(created, {
      type: "select",
      question: "q",
      option: "yes",
    });

    recordState(pi, selected);
    const submitted = transition(selected, { type: "submit" });
    recordState(pi, submitted);

    const types = sm
      .getBranch()
      .flatMap((entry) => (entry.type === "custom" ? [entry.customType] : []));

    expect(types).toStrictEqual([
      REQUEST_TYPE,
      STATE_TYPE,
      STATE_TYPE,
      STATE_TYPE,
    ]);
    expect(replay(sm.getBranch()).get("q_test")).toStrictEqual(submitted);
  });

  it("skips unreadable entries and states without a request instead of blocking recovery", () => {
    const { sm, pi } = session();
    const item = createInteraction("q_kept", request, "call", "async");
    recordRequest(pi, item);
    recordState(pi, item);
    sm.appendCustomEntry(STATE_TYPE, { id: "q_kept", retired: true });
    sm.appendCustomEntry(REQUEST_TYPE, { id: "q_broken" });
    recordState(pi, createInteraction("q_orphan", request, "call", "async"));

    const items = replay(sm.getBranch());

    expect([...items.keys()]).toStrictEqual(["q_kept"]);
    expect(items.get("q_kept")).toStrictEqual(item);
  });
});
