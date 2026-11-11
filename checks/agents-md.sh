#!/usr/bin/env bash
# Fails when AGENTS.md is longer than its line budget. Always-loaded prose costs tokens in every
# session, so a new line must replace an old one or become a check once the budget is full.
set -euo pipefail
cd "$(dirname "$0")/.."

limit=150
lines="$(wc -l < AGENTS.md | tr -d ' ')"
if [ "${lines}" -gt "${limit}" ]; then
  echo "AGENTS.md has ${lines} lines. The limit is ${limit}. Delete a line or turn one into a check." >&2
  exit 1
fi
echo "AGENTS.md has ${lines} of ${limit} lines."
