import { describe, expect, it } from "vite-plus/test";
import { collectAnswers, createInteraction, transition } from "../interaction.js";
import type { Action } from "../interaction.js";
import { validateRequest } from "../request.js";

const request = {
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
  ],
};
describe("questionnaire transitions", () => {
  it("requires explicit selection, retains deselected notes, and snapshots only selected answers", () => {
    let item = createInteraction("question_test", request, "call1", "blocking");
    const apply = (a: Action) => {
      item = transition(item, item.version, a);
    };
    expect(() => collectAnswers(item)).toThrow("Answer required");
    apply({ type: "select", question: "target", option: "local" });
    apply({ type: "note", question: "target", option: "local", text: "my local note" });
    apply({ type: "select", question: "target", option: "remote" });
    expect(item.draft?.answers.target.notes.local).toBe("my local note");
    apply({ type: "note", text: "overall" });
    apply({ type: "submit" });
    expect(item.submissions[0].answers.target.selections).toEqual([
      { option_id: "remote", label: "Remote" },
    ]);
    expect(item.submissions[0].note).toBe("overall");
    expect(() => apply({ type: "submit" })).toThrow("No editable draft");
  });
  it("reopens immutable revisions and rejects stale callbacks and concurrent reopens", () => {
    let item = createInteraction("question_test", request, "call1", "async");
    const apply = (a: Action) => {
      item = transition(item, item.version, a);
    };
    apply({ type: "select", question: "target", option: "local" });
    apply({ type: "submit" });
    const original = structuredClone(item.submissions[0]);
    apply({
      type: "reopen",
      base: 1,
      initiated_by: "agent",
      mode: "blocking",
      tool_call_id: "call2",
      reason: "Reconsider",
    });
    expect(() => apply({ type: "reopen", base: 1, initiated_by: "user", mode: "async" })).toThrow(
      "already exists",
    );
    expect(() => transition(item, 1, { type: "submit" })).toThrow("Stale");
    apply({ type: "custom", question: "target", text: "somewhere else" });
    apply({ type: "submit" });
    expect(item.submissions[0]).toEqual(original);
    expect(item.submissions[1]).toMatchObject({
      revision: 2,
      parent_revision: 1,
      tool_call_id: "call2",
      origin: "user",
    });
  });
  it("keeps custom text separate from notes and allows multi-select combinations", () => {
    let item = createInteraction(
      "question_test",
      { questions: [{ ...request.questions[0], multi_select: true }] },
      "c",
      "async",
    );
    for (const action of [
      { type: "select", question: "target", option: "local" },
      { type: "custom", question: "target", text: "also a third" },
      { type: "note", question: "target", text: "custom rationale" },
    ] satisfies Action[])
      item = transition(item, item.version, action);
    expect(collectAnswers(item).target).toMatchObject({
      selections: [{ option_id: "local" }],
      custom: { text: "also a third", note: "custom rationale" },
    });
  });
  it("supports IDs that also name Object prototype members without inventing notes", () => {
    let item = createInteraction(
      "q_names",
      {
        questions: [
          {
            id: "constructor",
            header: "ID",
            question: "Choose",
            options: [{ id: "toString", label: "Safe" }],
          },
        ],
      },
      "c",
      "blocking",
    );
    item = transition(item, item.version, {
      type: "select",
      question: "constructor",
      option: "toString",
    });
    item = transition(item, item.version, { type: "submit" });
    expect(Object.values(item.submissions[0].answers)[0].selections).toEqual([
      { option_id: "toString", label: "Safe" },
    ]);
  });
  it("rejects invalid IDs/recommendations and mixed schema branches", () => {
    expect(() => validateRequest({ ...request, retired: true })).toThrow();
    expect(() =>
      validateRequest({
        ...request,
        revise: { interaction_id: "x", base_revision: 1, reason: "why" },
      }),
    ).toThrow();
    expect(() =>
      validateRequest({
        questions: [
          { ...request.questions[0], recommendation: { option_ids: ["missing"], reason: "why" } },
        ],
      }),
    ).toThrow("recommendation");
    expect(() =>
      validateRequest({ questions: [request.questions[0], request.questions[0]] }),
    ).toThrow("Duplicate question");
  });
});
