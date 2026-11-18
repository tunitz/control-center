#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
bun test apps/server apps/web/src
bun run typecheck
bash tools/check_docs.sh
bash -n agent/ccagent.sh && bash -n agent/ccagent-gate && echo "agent scripts: syntax ok"
