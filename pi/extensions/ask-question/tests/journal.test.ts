import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { MESSAGE_TYPE, outcome } from "../delivery.js";
import { createInteraction, transition } from "../interaction.js";
import {
  REQUEST_TYPE,
  STATE_TYPE,
  recordRequest,
  recordState,
  project,
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

    const { items } = project(sm.getBranch());

    expect([...items.keys()]).toStrictEqual(["q_open"]);
    expect(items.get("q_open")).toStrictEqual(selected);
  });

  it("keeps a submitted draft until its outcome message is recorded", () => {
    const { sm, pi } = session();

    const item = transition(createInteraction("q_pending", request), {
      type: "select",
      question: "q",
      option: "yes",
    });

    recordRequest(pi, item);
    recordState(pi, item);

    expect(project(sm.getBranch()).items.get(item.id)).toStrictEqual(item);

    const result = outcome(item, "answered");
    sm.appendCustomMessageEntry(
      MESSAGE_TYPE,
      JSON.stringify(result),
      true,
      result
    );

    expect(project(sm.getBranch()).items.has(item.id)).toBe(false);
  });

  it("keeps a pending draft across replay and never reopens it after a recorded outcome", () => {
    const { sm, pi } = session();
    const item = { ...createInteraction("q_pending", request), pending: true };
    recordRequest(pi, item);
    recordState(pi, item);
    expect(project(sm.getBranch()).items.get(item.id)).toStrictEqual(item);

    const result = outcome(item, "dismissed");
    sm.appendCustomMessageEntry(
      MESSAGE_TYPE,
      JSON.stringify(result),
      true,
      result
    );
    recordState(pi, item);

    const projected = project(sm.getBranch());
    expect(projected.closed.has(item.id)).toBe(true);
    expect(projected.items.has(item.id)).toBe(false);
  });

  it("skips unreadable entries and states without a request instead of blocking recovery", () => {
    const { sm, pi } = session();
    const item = createInteraction("q_kept", request);
    recordRequest(pi, item);
    recordState(pi, item);
    sm.appendCustomEntry(STATE_TYPE, { id: "q_kept", draft: "unreadable" });
    sm.appendCustomEntry(REQUEST_TYPE, { id: "q_broken" });
    recordState(pi, createInteraction("q_orphan", request));

    const { items } = project(sm.getBranch());

    expect([...items.keys()]).toStrictEqual(["q_kept"]);
    expect(items.get("q_kept")).toStrictEqual(item);
  });

  it("restores questionnaires recorded with the fields earlier versions wrote", () => {
    const { sm } = session();
    const { draft } = createInteraction("q_legacy", request);

    sm.appendCustomEntry(REQUEST_TYPE, {
      id: "q_legacy",
      request,
      created_at: "2026-10-01T00:00:00.000Z",
      tool_call_id: "call_1",
    });
    sm.appendCustomEntry(STATE_TYPE, {
      id: "q_legacy",
      updated_at: "2026-10-01T00:00:00.000Z",
      status: "open",
      draft,
    });

    expect(project(sm.getBranch()).items.get("q_legacy")).toStrictEqual({
      id: "q_legacy",
      request: createInteraction("q_legacy", request).request,
      draft,
    });
  });
});
