#!/usr/bin/env bash
set -u

if node --test /app/test/ledger.test.js /tests/hidden.test.js >/logs/verifier/tests.tap 2>&1; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
