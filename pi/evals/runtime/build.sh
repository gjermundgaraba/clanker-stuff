#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
docker build \
  --file "$repo_root/pi/evals/runtime/Dockerfile" \
  --tag clanker-pi-evals:node26 \
  "$repo_root"
docker run --rm --network none clanker-pi-evals:node26 sh -c \
  'test "$(node --version | cut -d. -f1)" = v26 \
    && test ! -e /repo \
    && test "$(readlink -f /usr/local/bin/codex-eval)" = /opt/pi-evals/codex-eval.mjs \
    && codex-eval --self-test \
    && pi-eval-compact --self-test \
    && test "$(command -v pi)" = /opt/pi-evals/node_modules/.bin/pi \
    && test ! -e /usr/local/lib/node_modules/@earendil-works/pi-coding-agent \
    && cd /opt/pi-evals \
    && node --experimental-import-meta-resolve --input-type=module -e "
      import { realpathSync, readFileSync } from \"node:fs\";
      import { execFileSync } from \"node:child_process\";
      import { fileURLToPath } from \"node:url\";
      const expected = JSON.parse(readFileSync(\"node_modules/@earendil-works/pi-coding-agent/package.json\", \"utf8\")).version;
      if (execFileSync(\"pi\", [\"--version\"], { encoding: \"utf8\" }).trim() !== expected) {
        throw new Error(\"pi CLI version does not match \" + expected);
      }
      const wrapper = new URL(\"./pi-eval-tools.mjs\", import.meta.url);
      const cli = new URL(\"./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js\", import.meta.url);
      for (const name of [\"@earendil-works/pi-coding-agent\", \"@earendil-works/pi-ai\", \"@earendil-works/pi-tui\"]) {
        const wrapperPath = realpathSync(fileURLToPath(import.meta.resolve(name, wrapper)));
        const cliPath = realpathSync(fileURLToPath(import.meta.resolve(name, cli)));
        if (wrapperPath !== cliPath) throw new Error(name + \" resolved twice\");
        const dependency = JSON.parse(readFileSync(\"node_modules/\" + name + \"/package.json\", \"utf8\"));
        if (dependency.version !== expected) throw new Error(name + \" resolved to \" + dependency.version);
      }
    " \
    && codex --version'

# Exercise the actual native tool policy without network access or model calls.
read -r model thinking direct_tools < <(
  cd "$repo_root/pi/evals"
  PYTHONDONTWRITEBYTECODE=1 uv run --frozen --offline python -c 'from pi_evals.comparison import comparison; c=comparison(); import json; print(c["model"], c["thinking"], json.dumps(c["directTools"],separators=(",",":")))'
)
for mode in direct code_mode_only; do
  docker run --rm --network none \
    -e PI_CODING_AGENT_DIR=/tmp/pi-eval -e PI_EVAL_TOOL_MODE="$mode" \
    -e PI_EVAL_EXPERIMENT=code-mode -e PI_EVAL_MODEL="$model" -e PI_EVAL_THINKING="$thinking" -e PI_EVAL_DIRECT_TOOLS="$direct_tools" \
    clanker-pi-evals:node26 sh -c '
      pi --offline --no-session --no-context-files \
        --no-skills --no-prompt-templates --no-themes --no-extensions --no-approve \
        --extension /opt/pi-evals/pi-eval-tools.mjs \
        --model "$PI_EVAL_MODEL" --thinking "$PI_EVAL_THINKING" --print --mode json /eval-preflight \
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
      assert.equal(setup[0].model, process.argv[2]);
      assert.equal(setup[0].thinking, process.argv[3]);
      assert.equal(setup[0].mode, process.argv[1]);
      const direct = JSON.parse(process.argv[4]);
      assert.deepEqual(setup[0].activeTools, (process.argv[1] === "direct" ? direct : [...direct, "codemode"]).sort());
      assert.equal(events.some(event => event.type === "pi_eval_tools"), false);
    ' "$mode" "$model" "$thinking" "$direct_tools"
done
