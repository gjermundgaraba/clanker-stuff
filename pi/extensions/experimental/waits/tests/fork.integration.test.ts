import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../../tests/helpers/fs.js";
import extension from "../index.js";
import { OPENED } from "../journal.js";
import { WAKE_TYPE } from "../runtime.js";

const bind = async (session: AgentSession) => {
  await session.bindExtensions({ mode: "rpc" });
};

const hasEntry = (session: AgentSession, customType: string) =>
  session.sessionManager
    .getEntries()
    .some(
      (entry) =>
        (entry.type === "custom" || entry.type === "custom_message") &&
        entry.customType === customType
    );

describe("a fork through the real SDK runtime", () => {
  it("copies the parent's open wait but never runs it", async () => {
    const directory = await createTempDir("waits-fork-");
    const marker = path.join(directory, "result.json");
    const faux = fauxProvider();

    const runtime = await createAgentSessionRuntime(
      async (options) => {
        const modelRuntime = await ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
        });

        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey(faux.provider.id, "synthetic");

        const services = await createAgentSessionServices({
          cwd: options.cwd,
          agentDir: options.agentDir,
          modelRuntime,
          settingsManager: SettingsManager.inMemory({
            retry: { enabled: false },
          }),
          resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            extensionFactories: [extension],
          },
        });

        const result = await createAgentSessionFromServices({
          services,
          sessionManager: options.sessionManager,
          ...(options.sessionStartEvent
            ? { sessionStartEvent: options.sessionStartEvent }
            : {}),
          model: faux.getModel(),
        });

        return { ...result, services, diagnostics: services.diagnostics };
      },
      {
        cwd: directory,
        agentDir: path.join(directory, "agent"),
        sessionManager: SessionManager.create(
          directory,
          path.join(directory, "sessions")
        ),
      }
    );

    runtime.setRebindSession(bind);

    try {
      await bind(runtime.session);
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("wait_start", {
            label: "job result",
            condition: `test -f ${JSON.stringify(marker)}`,
            instruction: "Consume the result once.",
            intervalSeconds: 1,
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("Waiting."),
      ]);
      await runtime.session.prompt("Wait for the job");

      const leaf = runtime.session.sessionManager.getLeafId();

      if (leaf === null) {
        throw new Error("The session has no leaf");
      }

      await runtime.fork(leaf, { position: "at" });
      expect(hasEntry(runtime.session, OPENED)).toBe(true);

      await writeFile(marker, "{}");
      await delay(1500);

      expect(hasEntry(runtime.session, WAKE_TYPE)).toBe(false);
    } finally {
      await runtime.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      runtime.session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
