#!/usr/bin/env bash
# Publishes a release on the PUBLIC agent repo (tunitz/ccagent) with the generic installer attached. Usage: tools/release.sh v0.3.0
# The dashboard repo stays private; only the agent installer is public.
# Needs GITHUB_TOKEN (repo scope). Units download it anonymously (curl, no token).
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=${1:?tag, e.g. v0.2.0}; REPO=${REPO:-tunitz/ccagent}
: "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
bun run tools/build-installer.ts dist/install-ccagent.sh
API=https://api.github.com/repos/$REPO
REL=$(curl -fsS -X POST "$API/releases" -H "Authorization: Bearer $GITHUB_TOKEN" -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"generate_release_notes\":true}")
ID=$(echo "$REL" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -fsS -X POST "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=install-ccagent.sh" -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: text/x-shellscript" --data-binary @dist/install-ccagent.sh | python3 -c 'import sys,json;d=json.load(sys.stdin);print("asset:",d["name"],d["size"],"bytes")'
echo "release $TAG published"
