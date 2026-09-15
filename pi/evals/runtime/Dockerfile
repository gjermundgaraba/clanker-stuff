FROM node:26.8.2-bookworm-slim AS extension

RUN npm install --global pnpm@12.4.1
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY pi/extensions/experimental/codex-provider ./pi/extensions/experimental/codex-provider
COPY pi/packages/footer-protocol ./pi/packages/footer-protocol
COPY pi/packages/lazy-singleton ./pi/packages/lazy-singleton
COPY pi/packages/extension-paths ./pi/packages/extension-paths
RUN pnpm --filter @clanker-stuff/codex-provider deploy \
    --prod --legacy --frozen-lockfile --ignore-scripts /out \
  && test ! -e /out/evals \
  && test ! -e /out/scripts \
  && test ! -e /out/tests

FROM node:26.8.2-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --ignore-scripts \
    @openai/codex@0.147.0
COPY --from=extension /out /opt/codex-provider
COPY pi/evals/runtime/pi-eval-tools.mjs pi/evals/runtime/eval-journal.mjs pi/evals/runtime/service-tools.mjs /opt/codex-provider/
# Install the checksum-pinned host in the same private Pi home used by the adapter.
RUN cd /opt/codex-provider && node --input-type=module -e \
    'import { installCodeModeHost } from "./code-mode/install-host.ts"; import { HOST_RELEASE } from "./code-mode/host-assets.ts"; await installCodeModeHost({platform: process.platform, arch: process.arch, destination: `/tmp/pi-eval/cache/codex-provider/code-mode/${HOST_RELEASE}/${process.platform}-${process.arch}/codex-code-mode-host`});'

COPY pi/evals/runtime/codex-eval.mjs /opt/codex-provider/codex-eval.mjs
COPY pi/evals/runtime/pi-eval-compact.mjs /usr/local/bin/pi-eval-compact
RUN chmod 755 /opt/codex-provider/codex-eval.mjs /usr/local/bin/pi-eval-compact \
  && ln -s /opt/codex-provider/codex-eval.mjs /usr/local/bin/codex-eval
ENV PATH="/opt/codex-provider/node_modules/.bin:${PATH}"
WORKDIR /app
