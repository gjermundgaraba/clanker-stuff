#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
docker build \
  --file "$repo_root/pi/evals/runtime/Dockerfile" \
  --tag clanker-pi-evals:node24 \
  "$repo_root"
docker run --rm clanker-pi-evals:node24 sh -c \
  'test "$(node --version | cut -d. -f1)" = v24 \
    && test ! -e /repo \
    && test ! -e /opt/codex-provider/evals \
    && test -x /usr/local/bin/mem2act \
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
      const manifest = JSON.parse(readFileSync(\"package.json\", \"utf8\"));
      const expected = manifest.peerDependencies[
        \"@earendil-works/pi-coding-agent\"
      ];
      if (execFileSync(\"pi\", [\"--version\"], { encoding: \"utf8\" }).trim() !== expected) {
        throw new Error(\"pi CLI version does not match \" + expected);
      }
      const extension = new URL(\"./index.ts\", import.meta.url);
      const cli = new URL(
        \"./node_modules/@earendil-works/pi-coding-agent/dist/cli.js\",
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
