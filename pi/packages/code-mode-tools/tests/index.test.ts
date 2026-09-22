import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  collectContributions,
  ContributedTools,
  CONTRIBUTIONS_PUBLISH,
  CONTRIBUTIONS_REQUEST,
} from "../index.js";

describe("contributed tools", () => {
  it("publishes one complete inventory and keeps snapshot reads side-effect free", async () => {
    let source: ContributedTools | undefined;

    const changed = vi.fn();

    const host = createExtensionHost((pi) => {
      pi.events.on(CONTRIBUTIONS_PUBLISH, changed);
      source = new ContributedTools(pi);

      for (const name of ["one", "two"])
        source.registerTool({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          execute: async () => ({ content: [], details: undefined }),
        });
      expect(collectContributions(pi)).toEqual([{ ownedNames: [], tools: [] }]);
    });

    await host.ready;

    if (!source) throw new Error("Missing source");
    expect(changed).not.toHaveBeenCalled();
    host.setActiveTools(["foreign"]);
    source.setEnabled(["one"]);
    expect(changed).toHaveBeenCalledTimes(1);
    const before = host.getActiveTools();
    expect(source.snapshot().tools.map(({ definition }) => definition.name)).toEqual(["one"]);
    expect(host.getActiveTools()).toEqual(before);
    source.setEnabled(["two"]);
    expect(host.getActiveTools()).toEqual(["foreign", "two"]);
    expect(source.snapshot().tools.map(({ definition }) => definition.name)).toEqual(["two"]);
    await host.emitSessionShutdown();
  });

  it("rejects malformed snapshots at the receiving boundary", async () => {
    let collect: (() => ReturnType<typeof collectContributions>) | undefined;
    const requestSchema = Type.Object({ accept: Type.Function([Type.Unknown()], Type.Unknown()) });

    const host = createExtensionHost((pi) => {
      collect = () => collectContributions(pi);
      pi.events.on(CONTRIBUTIONS_REQUEST, (request) => {
        if (Value.Check(requestSchema, request))
          request.accept({
            ownedNames: ["bad"],
            tools: [{ definition: { name: "bad" }, resultMode: "content" }],
          });
      });
    });

    await host.ready;

    if (!collect) throw new Error("Missing collector");
    expect(collect).toThrow("Invalid Code Mode tool inventory");
    await host.emitSessionShutdown();
  });

  it("rejects revoked or replaced definitions retained by old cells", async () => {
    let source: ContributedTools | undefined;

    const host = createExtensionHost((pi) => {
      source = new ContributedTools(pi);
    });

    await host.ready;

    if (!source) throw new Error("Missing source");

    const definition = {
      name: "probe",
      label: "Probe",
      description: "Probe",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined }),
    };

    source.registerTool(definition);
    source.setEnabled(["probe"]);
    const first = source.snapshot().tools[0];

    if (!first) throw new Error("Missing tool");

    const invoke = () =>
      first.definition.execute("id", {}, undefined, undefined, host.createContext());

    await invoke();
    source.setEnabled([]);
    expect(invoke).toThrow("no longer available");
    source.registerTool({ ...definition, description: "replacement" });
    source.setEnabled(["probe"]);
    expect(invoke).toThrow("no longer available");
    await host.emitSessionShutdown();
  });
});
