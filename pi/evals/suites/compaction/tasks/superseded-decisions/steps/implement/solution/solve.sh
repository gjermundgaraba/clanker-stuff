#!/usr/bin/env bash
set -eu
cp /solution/deployment.js /app/src/deployment.js
mkdir -p /logs/agent
cp /solution/trajectory.json /logs/agent/trajectory.json
