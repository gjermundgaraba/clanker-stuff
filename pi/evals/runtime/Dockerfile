FROM node:24-bookworm-slim AS extension

RUN npm install --global pnpm@10.33.2
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY pi/extensions/codex-provider ./pi/extensions/codex-provider
COPY pi/packages/extension-paths ./pi/packages/extension-paths
RUN pnpm --filter @clanker-stuff/codex-provider deploy --prod --legacy /out \
  && test ! -e /out/evals \
  && test ! -e /out/scripts \
  && test ! -e /out/tests

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --ignore-scripts \
    @earendil-works/pi-coding-agent@0.84.1 \
    @openai/codex@0.147.0
COPY --from=extension /out /opt/codex-provider
COPY pi/evals/runtime/mem2act.mjs /usr/local/bin/mem2act
RUN chmod 755 /usr/local/bin/mem2act
WORKDIR /app
