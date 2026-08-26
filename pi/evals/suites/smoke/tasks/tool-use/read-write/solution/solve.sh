#!/usr/bin/env bash
set -eu
printf 'CITRINE-47-EMBER\n' > /app/answer.txt
mkdir -p /logs/agent
cp /solution/trajectory.json /logs/agent/trajectory.json
