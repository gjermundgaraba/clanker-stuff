#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
docker build \
  --file "$repo_root/pi/evals/runtime/Dockerfile" \
  --tag clanker-pi-evals:node24 \
  "$repo_root"
docker run --rm clanker-pi-evals:node24 sh -c \
  'test "$(node --version | cut -d. -f1)" = v24 && test ! -e /repo && test ! -e /opt/codex-provider/evals && test -x /usr/local/bin/mem2act && pi --version && codex --version'
