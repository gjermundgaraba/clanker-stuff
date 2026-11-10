import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { Coordinator } from "../coordinator.js";

const questionnaire = (title: string) => ({
  wait: false,
  title,
  questions: [
    {
      id: "q",
      header: "Question",
      question: "Choose?",
      options: [{ id: "yes", label: "Yes" }],
    },
  ],
});

const titles = (coordinator: Coordinator) =>
  coordinator.list().map((item) => item.request.title);

describe("open questionnaires", () => {
  it("list the most recently changed first, in the same order after a reload", async () => {
    let api: ExtensionAPI | undefined;

    const host = createExtensionHost((pi) => {
      api = pi;
    });

    await host.ready;

    const ctx = host.createContext();
    const coordinator = new Coordinator(api!);
    coordinator.attach(ctx);

    for (const title of ["first", "second", "third"]) {
      await coordinator.ask(questionnaire(title), undefined, ctx);
    }

    const second = coordinator
      .list()
      .find((item) => item.request.title === "second")!;

    coordinator.mutate(second.id, {
      type: "select",
      question: "q",
      option: "yes",
    });

    expect(titles(coordinator)).toStrictEqual(["second", "third", "first"]);

    const reloaded = new Coordinator(api!);
    reloaded.attach(ctx);

    expect(titles(reloaded)).toStrictEqual(titles(coordinator));
  });
});
