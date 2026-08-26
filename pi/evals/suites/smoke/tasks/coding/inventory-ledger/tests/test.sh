#!/usr/bin/env bash
set -u

if node --test /app/test/ledger.test.js /tests/hidden.test.js >/logs/verifier/tests.tap 2>&1; then
  quality=1
else
  quality=0
fi
printf '{"quality":%s,"tests":%s,"valid_experiment":1,"reward":%s}\n' "$quality" "$quality" "$quality" \
  > /logs/verifier/reward.json
