FROM node:26.8.2-bookworm-slim AS runtime

RUN npm install --global pnpm@12.5.1
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY pi/evals/runtime ./pi/evals/runtime
RUN pnpm --filter @clanker-stuff/pi-evals-runtime deploy \
    --prod --legacy --frozen-lockfile --ignore-scripts /out

FROM node:26.8.2-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --ignore-scripts \
    @openai/codex@0.159.2
COPY --from=runtime /out /opt/pi-evals
COPY pi/evals/runtime/pi-eval-compact.mjs /usr/local/bin/pi-eval-compact
RUN chmod 755 /opt/pi-evals/codex-eval.mjs /usr/local/bin/pi-eval-compact \
  && ln -s /opt/pi-evals/codex-eval.mjs /usr/local/bin/codex-eval
ENV PATH="/opt/pi-evals/node_modules/.bin:${PATH}"
WORKDIR /app
