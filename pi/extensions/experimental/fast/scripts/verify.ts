import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { probeTier } from "./probe.ts";

const modelId = process.argv[2] ?? "gpt-6.1-sol";

const selectedTier = process.argv[3] ?? "priority";

if (selectedTier !== "default" && selectedTier !== "priority" && selectedTier !== "fast")
  throw new Error("Usage: verify.ts [MODEL_ID] [default|priority|fast]");

const runtime = await ModelRuntime.create();

const model = runtime.getModel("openai", modelId);

if (model === undefined) throw new Error("Select an available native OpenAI subscription model.");

const result = await probeTier(runtime, model, selectedTier);

console.log(JSON.stringify(result));

if (!result.requestSucceeded) process.exitCode = 1;
