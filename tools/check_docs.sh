#!/usr/bin/env bash
# Documentation hygiene check: forbidden stale/personal markers and broken relative Markdown links.
# Scans README.md, Markdown under docs/, deploy/ and .claude/, plus the ignore files.
set -u

cd "$(dirname "$0")/.." || exit 1
fail=0

md_files=()
for f in README.md AGENTS.md CONTRIBUTING.md SECURITY.md; do
  [ -f "$f" ] && md_files+=("$f")
done
while IFS= read -r f; do md_files+=("$f"); done < <(find docs deploy .claude -type f -name '*.md' -print 2>/dev/null | sort)

scan_files=("${md_files[@]-}")
for f in .gitignore .dockerignore; do
  [ -f "$f" ] && scan_files+=("$f")
done

# Removed-feature and user-specific markers. Exclude this script so the patterns themselves never match.
markers="(/api/chat|PiConfigCard|PiSkillsCard|CHAT_UPLOAD_DIR|pi-bridge/|chatmock|auto-migrates|/home/tunitz|~/\\.hermes|192\\.168\\.31\\.|100\\.67\\.153\\.|tun['’]s|tun:|tun-sfx|tun-minipc|d8:43:ae)"
for f in "${scan_files[@]}"; do
  [ -z "$f" ] && continue
  [ "$f" = "tools/check_docs.sh" ] && continue
  if matches=$(grep -niE --exclude=check_docs.sh "$markers" "$f" 2>/dev/null); then
    printf '%s\n' "$matches" | sed "s|^|forbidden marker in $f:|"
    fail=1
  fi
done

# Relative Markdown links must resolve to an existing file or directory.
# Fenced code blocks are skipped so examples do not create false positives.
for f in "${md_files[@]-}"; do
  [ -z "$f" ] && continue
  dir=$(dirname "$f")
  links=$(awk '/^[[:space:]]*(```|~~~)/ { block = !block; next } !block' "$f" |
    grep -oE '\]\([^)]+\)' | sed -E 's/^\]\(//; s/\)$//')
  [ -z "$links" ] && continue
  while IFS= read -r raw; do
    [ -z "$raw" ] && continue
    target=${raw%%[[:space:]]*}
    target=${target#<}; target=${target%>}
    target=${target#\"}; target=${target%\"}
    case "$target" in
      ''|'#'*|http://*|https://*|mailto:*|tel:*|data:*|attachment://*) continue ;;
    esac
    path=${target%%#*}
    [ -z "$path" ] && continue
    case "$path" in /*) continue ;; esac
    if [ ! -e "$dir/$path" ]; then
      printf '%s: broken relative link: %s\n' "$f" "$target"
      fail=1
    fi
  done <<< "$links"
done

if [ "$fail" -ne 0 ]; then
  echo "docs check failed"
  exit 1
fi
echo "docs check ok"
