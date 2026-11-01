FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS runtime

RUN npm install --global pnpm@12.17.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY pi/evals/runtime ./pi/evals/runtime
RUN pnpm --filter @clanker-stuff/pi-evals-runtime deploy \
    --prod --legacy --frozen-lockfile --ignore-scripts /out

FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --ignore-scripts \
    @openai/codex@0.159.2
COPY --from=runtime /out /opt/pi-evals
RUN chmod 755 /opt/pi-evals/codex-eval.mjs /opt/pi-evals/pi-eval-compact.mjs \
  && ln -s /opt/pi-evals/codex-eval.mjs /usr/local/bin/codex-eval \
  && ln -s /opt/pi-evals/pi-eval-compact.mjs /usr/local/bin/pi-eval-compact
ENV PATH="/opt/pi-evals/node_modules/.bin:${PATH}"
WORKDIR /app
