#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
bun test apps/server
bun run typecheck
bash -n agent/ccagent.sh && bash -n agent/ccagent-gate && echo "agent scripts: syntax ok"
