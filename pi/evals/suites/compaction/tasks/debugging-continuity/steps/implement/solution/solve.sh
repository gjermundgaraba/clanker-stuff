#!/usr/bin/env bash
set -eu
cp /solution/route.js /app/src/route.js
mkdir -p /logs/agent
cp /solution/trajectory.json /logs/agent/trajectory.json
