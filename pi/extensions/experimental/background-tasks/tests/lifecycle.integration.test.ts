import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, it, expect } from "vite-plus/test";
import extension from "../index.js";

describe("session replacement through the real SDK runtime", () => {
  it("cleans up on clone, fork, new and resume without restoring inherited tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "background-lifecycle-"));
    const faux = fauxProvider();
    const bind = (session: AgentSession) => session.bindExtensions({ mode: "tui" });

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
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
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
          ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}),
          model: faux.getModel(),
        });

        return { ...result, services, diagnostics: services.diagnostics };
      },
      {
        cwd: directory,
        agentDir: join(directory, "agent"),
        sessionManager: SessionManager.create(directory, join(directory, "sessions")),
      },
    );

    runtime.setRebindSession(bind);

    try {
      await bind(runtime.session);
      const schema = Type.Object({ id: Type.String(), pid: Type.Number() });

      const start = async () => {
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall("task_start", {
              name: "synthetic-server",
              command: process.execPath,
              args: ["-e", "setInterval(()=>{},1000)"],
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Started"),
        ]);
        await runtime.session.prompt("Start a synthetic server");

        const entry = runtime.session.sessionManager
          .getEntries()
          .findLast((e) => e.type === "custom" && e.customType === "background-tasks:lifecycle");

        if (entry?.type !== "custom") throw new Error("Missing lifecycle");

        return Value.Parse(schema, entry.data);
      };

      const assertEmpty = async () => {
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("task_list", {}), { stopReason: "toolUse" }),
          fauxAssistantMessage("Listed"),
        ]);
        await runtime.session.prompt("Inspect live ownership", { source: "extension" });

        const result = runtime.session.messages.findLast(
          (m) => m.role === "toolResult" && m.toolName === "task_list",
        );

        expect(JSON.stringify(result)).toContain('\\"tasks\\":[]');
      };

      const first = await start();
      const originalFile = runtime.session.sessionManager.getSessionFile()!;
      // /clone forks at the current leaf, including it.
      await runtime.fork(runtime.session.sessionManager.getLeafId()!, { position: "at" });
      expect(() => process.kill(first.pid, 0)).toThrow();
      await assertEmpty();

      const second = await start();

      const forkEntry = runtime.session.sessionManager
        .getEntries()
        .findLast((e) => e.type === "message" && e.message.role === "user")!;

      await runtime.fork(forkEntry.id);
      expect(() => process.kill(second.pid, 0)).toThrow();
      await assertEmpty();

      const third = await start();
      await runtime.newSession();
      expect(() => process.kill(third.pid, 0)).toThrow();
      await assertEmpty();

      const fourth = await start();
      await runtime.switchSession(originalFile);
      expect(() => process.kill(fourth.pid, 0)).toThrow();
      await assertEmpty();
    } finally {
      await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      runtime.session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
