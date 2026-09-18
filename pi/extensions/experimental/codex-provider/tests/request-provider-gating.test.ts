import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { codexContractFixture } from "../../subagents/docs/fixtures/codex-contract.generated.js";
import type { CollaborationContractRequest } from "../collaboration.js";
import { COLLABORATION_CONTRACT_REQUEST } from "../collaboration.js";
import { createCodexRuntime } from "../runtime.js";
import { SPIKE_MODEL, wireRecord } from "./fixtures.js";

const GROK_MODEL = {
  ...SPIKE_MODEL,
  api: "openai-responses",
  id: "grok-4.6",
  name: "Grok",
  provider: "xai",
} satisfies Model<"openai-responses">;

describe("Codex request provider gating", () => {
  it.each(["v1", "v2"] as const)(
    "preserves Grok tools after background Codex loading with %s collaboration",
    async (protocol) => {
      let runtime: ReturnType<typeof createCodexRuntime> | undefined;

      const host = createExtensionHost(
        (pi) => {
          pi.events.on(COLLABORATION_CONTRACT_REQUEST, (data) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: This bus has one collaboration request producer; Pi erases the shared callback contract.
            const request = data as CollaborationContractRequest;
            request.provide({
              nestedTools: [],
              protocol,
              sessionId: request.sessionId,
              version: 1,
            });
          });
          runtime = createCodexRuntime(pi, () => {});
        },
        { model: GROK_MODEL },
      );

      const ctx = host.createContext();
      await host.emitSessionStart(ctx);

      if (runtime === undefined) throw new Error("Runtime was not initialized");

      const tools = codexContractFixture[protocol].tools.map((name) => ({
        name,
        parameters: { properties: {}, type: "object" },
        type: "function",
      }));

      const payload = {
        input: [{ tools, type: "additional_tools" }],
        tools,
      };

      const event = { payload, type: "before_provider_request" as const };
      const original = structuredClone(payload);

      try {
        // The first Grok turn leaves the Codex lifecycle unloaded.
        expect(await runtime.beforeProviderRequest(event, ctx)).toBeUndefined();

        // Recap's registry call loads the same provider without switching the session model.
        await runtime.loadProvider();
        expect(await runtime.beforeProviderRequest(event, ctx)).toBe(payload);
        expect(payload).toStrictEqual(original);

        // The loaded lifecycle must still project both standard and Lite Codex requests.
        const codexPayload = wireRecord(
          await runtime.beforeProviderRequest(event, host.createContext({ model: SPIKE_MODEL })),
        );

        const namespace = {
          name: "pi_subagents",
          type: "namespace",
        };

        expect(codexPayload.tools).toMatchObject([namespace]);
        expect(codexPayload.input).toMatchObject([{ tools: [namespace] }]);
        expect(payload).toStrictEqual(original);
      } finally {
        await runtime.shutdown(ctx);
      }
    },
  );
});
