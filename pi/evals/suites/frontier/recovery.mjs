// Model-free integration probe, executed in the frozen runtime with network disabled.
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const settings = JSON.parse(process.argv[2]);
const modelRuntime = await ModelRuntime.create({ agentDir: "/tmp/recovery-probe" });
await modelRuntime.setRuntimeApiKey("openai", "offline-probe");
const model = modelRuntime.getModel("openai", "gpt-4o");
assert.ok(model);
const resourceLoader = new DefaultResourceLoader({
  cwd: "/tmp",
  agentDir: "/tmp/recovery-probe",
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  agentsFilesOverride: () => ({ agentsFiles: [] }),
});
await resourceLoader.reload();

for (const recover of [true, false]) {
  let toolRuns = 0;
  const { session } = await createAgentSession({
    cwd: "/tmp",
    model,
    modelRuntime,
    resourceLoader,
    settingsManager: SettingsManager.inMemory(settings),
    sessionManager: SessionManager.inMemory("/tmp"),
    tools: ["probe"],
    customTools: [
      {
        name: "probe",
        label: "probe",
        description: "Increment an in-memory counter",
        parameters: Type.Object({}),
        execute: async () => {
          toolRuns++;
          return { content: [{ type: "text", text: "done" }], details: {} };
        },
      },
    ],
  });
  const failure = () =>
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "WebSocket error: stream failed",
    });
  const responses = [
    fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
    failure(),
    ...(recover ? [fauxAssistantMessage("recovered")] : [failure(), failure(), failure()]),
  ];
  const events = [];
  session.subscribe((event) => events.push(event));
  let calls = 0;
  session.agent.streamFunction = () => {
    const response = responses[calls++];
    assert.ok(response, "unexpected extra request");
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: response });
    if (response.stopReason === "error") {
      stream.push({ type: "error", reason: "error", error: response });
    } else {
      stream.push({ type: "done", reason: response.stopReason, message: response });
    }
    stream.end();
    return stream;
  };
  await session.prompt("Run the probe, then answer.");
  assert.equal(toolRuns, 1, "completed tools must not be replayed");
  assert.equal(calls, recover ? 3 : 5);
  assert.equal(events.filter((e) => e.type === "auto_retry_start").length, recover ? 1 : 3);
  assert.equal(events.find((e) => e.type === "auto_retry_end")?.success, recover);
  assert.equal(events.at(-1)?.type, "agent_settled");
  assert.equal(session.messages.at(-1)?.stopReason, recover ? "stop" : "error");
  session.dispose();
}
console.log("Pi retry recovery, no tool replay, and retry exhaustion passed (no model calls).");
