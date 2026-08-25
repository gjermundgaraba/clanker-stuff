FROM node:26.7.0-bookworm-slim AS extension

RUN npm install --global pnpm@11.22.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY pi/extensions/experimental/codex-provider ./pi/extensions/experimental/codex-provider
COPY pi/packages/footer-protocol ./pi/packages/footer-protocol
COPY pi/packages/lazy-singleton ./pi/packages/lazy-singleton
COPY pi/packages/extension-paths ./pi/packages/extension-paths
COPY pi/packages/tool-owner-protocol ./pi/packages/tool-owner-protocol
RUN pnpm --filter @clanker-stuff/codex-provider deploy \
    --prod --legacy --frozen-lockfile --ignore-scripts /out \
  && test ! -e /out/evals \
  && test ! -e /out/scripts \
  && test ! -e /out/tests

FROM node:26.7.0-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --ignore-scripts \
    @openai/codex@0.147.0
COPY --from=extension /out /opt/codex-provider
COPY pi/evals/runtime/codex-eval.mjs /usr/local/bin/codex-eval
COPY pi/evals/runtime/pi-eval-compact.mjs /usr/local/bin/pi-eval-compact
COPY pi/evals/runtime/mem2act.mjs /usr/local/bin/mem2act
RUN chmod 755 /usr/local/bin/codex-eval /usr/local/bin/pi-eval-compact /usr/local/bin/mem2act
ENV PATH="/opt/codex-provider/node_modules/.bin:${PATH}"
WORKDIR /app
