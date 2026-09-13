#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
docker build \
  --file "$repo_root/pi/evals/runtime/Dockerfile" \
  --tag clanker-pi-evals:node26 \
  "$repo_root"
docker run --rm clanker-pi-evals:node26 sh -c \
  'test "$(node --version | cut -d. -f1)" = v26 \
    && test ! -e /repo \
    && test ! -e /opt/codex-provider/evals \
    && codex-eval --self-test \
    && pi-eval-compact --self-test \
    && test "$(command -v pi)" = /opt/codex-provider/node_modules/.bin/pi \
    && test ! -e /usr/local/lib/node_modules/@earendil-works/pi-coding-agent \
    && pi --offline --no-session --no-context-files --no-skills \
      --no-prompt-templates --no-themes --no-extensions \
      --extension /opt/codex-provider/index.ts --help >/tmp/pi-help 2>&1 \
    && grep -F -- "--fast" /tmp/pi-help \
    && cd /opt/codex-provider \
    && node --experimental-import-meta-resolve --input-type=module -e "
      import { realpathSync, readFileSync } from \"node:fs\";
      import { execFileSync } from \"node:child_process\";
      import { fileURLToPath } from \"node:url\";
      const expected = JSON.parse(
        readFileSync(
          \"node_modules/@earendil-works/pi-coding-agent/package.json\",
          \"utf8\",
        ),
      ).version;
      if (execFileSync(\"pi\", [\"--version\"], { encoding: \"utf8\" }).trim() !== expected) {
        throw new Error(\"pi CLI version does not match \" + expected);
      }
      const extension = new URL(\"./index.ts\", import.meta.url);
      const cli = new URL(
        \"./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js\",
        import.meta.url,
      );
      for (const name of [
        \"@earendil-works/pi-coding-agent\",
        \"@earendil-works/pi-ai\",
        \"@earendil-works/pi-tui\",
      ]) {
        const extensionPath = realpathSync(
          fileURLToPath(import.meta.resolve(name, extension)),
        );
        const cliPath = realpathSync(fileURLToPath(import.meta.resolve(name, cli)));
        if (extensionPath !== cliPath) throw new Error(name + \" resolved twice\");
        const dependency = JSON.parse(
          readFileSync(\"node_modules/\" + name + \"/package.json\", \"utf8\"),
        );
        if (dependency.version !== expected) {
          throw new Error(name + \" resolved to \" + dependency.version);
        }
      }
    " \
    && codex --version'

# Exercise the real wrapper and catalog policy without a model request or credentials.
for mode in direct code_mode_only; do
  docker run --rm \
    -e PI_CODING_AGENT_DIR=/tmp/pi-eval -e PI_EVAL_TOOL_MODE="$mode" \
    clanker-pi-evals:node26 sh -c '
      pi --offline --no-session --no-context-files \
        --no-skills --no-prompt-templates --no-themes --no-extensions --no-approve \
        --extension /opt/codex-provider/pi-eval-tools.mjs \
        --model openai-codex/gpt-6-astra --thinking high --print --mode json /code-mode \
        >/tmp/pi-json &&
      node -e "for (const line of require(\"fs\").readFileSync(\"/tmp/pi-json\",\"utf8\").split(\"\\n\")) if (line.trim()) JSON.parse(line)" &&
      cat /logs/agent/eval-events.jsonl' |
    node --input-type=module -e '
      import assert from "node:assert/strict";
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const events = input.trim().split("\n").map(line => JSON.parse(line));
      const setup = events.filter(event => event.type === "pi_eval_setup");
      assert.equal(setup.length, 1);
      assert.equal(setup[0].model, "openai-codex/gpt-6-astra");
      assert.equal(setup[0].thinking, "high");
      assert.equal(setup[0].mode, process.argv[1]);
      assert.deepEqual(setup[0].activeTools, process.argv[1] === "direct"
        ? ["apply_patch", "exec_command", "view_image", "write_stdin"] : ["exec", "wait"]);
      assert.equal(events.some(event => event.type === "pi_eval_tools"), false);
    ' "$mode"
done
