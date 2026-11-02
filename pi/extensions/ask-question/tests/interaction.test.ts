import assert from "node:assert/strict";

import { describe, expect, it } from "vite-plus/test";

import {
  collectAnswers,
  createInteraction,
  transition,
} from "../interaction.js";
import type { Action } from "../interaction.js";
import type { Question } from "../request.js";

const request = {
  wait: true,
  questions: [
    {
      id: "target",
      header: "Target",
      question: "Where?",
      options: [
        { id: "local", label: "Local" },
        { id: "remote", label: "Remote" },
      ],
    },
  ] satisfies [Question],
};

describe("questionnaire transitions", () => {
  it("requires explicit selection, retains deselected notes, and snapshots only selected answers", () => {
    let item = createInteraction("question_test", request, "call1");

    const apply = (a: Action) => {
      item = transition(item, a);
    };

    expect(() => collectAnswers(item)).toThrow("Answer required");
    expect(() => {
      apply({ type: "submit" });
    }).toThrow("Answer required");
    expect(item.status).toBe("open");
    apply({ type: "select", question: "target", option: "local" });
    apply({
      type: "note",
      question: "target",
      option: "local",
      text: "my local note",
    });
    apply({ type: "select", question: "target", option: "remote" });
    expect(item.draft?.["target"]?.notes["local"]).toBe("my local note");
    expect(collectAnswers(item)["target"]?.selections).toStrictEqual([
      { option_id: "remote", label: "Remote" },
    ]);
    apply({ type: "submit" });
    expect(item.status).toBe("answered");
    expect(item.draft).toBeUndefined();
    expect(() => {
      apply({ type: "submit" });
    }).toThrow("no longer open");
  });

  it("dismisses an open draft and restores one that was taken back", () => {
    let item = createInteraction("question_test", request, "call1");
    item = transition(item, {
      type: "select",
      question: "target",
      option: "local",
    });
    const { draft } = item;
    assert.ok(draft);

    const dismissed = transition(item, { type: "dismiss" });
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.draft).toBeUndefined();
    expect(() =>
      transition(dismissed, {
        type: "select",
        question: "target",
        option: "remote",
      })
    ).toThrow("no longer open");

    const answered = transition(item, { type: "submit" });
    const restored = transition(answered, { type: "restore", draft });
    expect(restored.status).toBe("open");
    expect(restored.draft).toStrictEqual(draft);
  });

  it("rejects a persisted draft missing the question's answer record without mutating it", () => {
    const item = createInteraction("question_test", request, "call1");
    assert.ok(item.draft);
    delete item.draft["target"];
    const before = structuredClone(item);
    expect(() =>
      transition(item, { type: "select", question: "target", option: "local" })
    ).toThrow("Unknown question: target");
    expect(item).toStrictEqual(before);
  });

  it("keeps custom text separate from notes and allows multi-select combinations", () => {
    let item = createInteraction(
      "question_test",
      {
        ...request,
        questions: [{ ...request.questions[0], multi_select: true }],
      },
      "c"
    );

    for (const action of [
      { type: "select", question: "target", option: "local" },
      { type: "custom", question: "target", text: "also a third" },
      { type: "note", question: "target", text: "custom rationale" },
    ] satisfies Action[]) {
      item = transition(item, action);
    }

    expect(collectAnswers(item)["target"]).toMatchObject({
      selections: [{ option_id: "local" }],
      custom: { text: "also a third", note: "custom rationale" },
    });
  });

  it("supports IDs that also name Object prototype members without inventing notes", () => {
    let item = createInteraction(
      "q_names",
      {
        wait: true,
        questions: [
          {
            id: "constructor",
            header: "ID",
            question: "Choose",
            options: [{ id: "toString", label: "Safe" }],
          },
        ],
      },
      "c"
    );

    item = transition(item, {
      type: "select",
      question: "constructor",
      option: "toString",
    });
    expect(Object.values(collectAnswers(item))[0]?.selections).toStrictEqual([
      { option_id: "toString", label: "Safe" },
    ]);
  });
});
