#!/usr/bin/env bash
# Fails when a generated file differs from what the generators write now: api/openapi.json from
# the route schemas, and the UI client in ui/src/api from api/openapi.json. Run it after
# `npm run build`, because the OpenAPI document comes from dist/bin/openapi.js.
# `just gen` rewrites both. The check compares against the working tree, not git, so it holds
# before a commit as well as in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT

node dist/bin/openapi.js > "${scratch}/openapi.json"
if ! diff -u api/openapi.json "${scratch}/openapi.json"; then
  echo "api/openapi.json is stale. Run: just gen" >&2
  exit 1
fi

cp -R ui/src/api "${scratch}/api"
(cd ui && npm run --silent gen:api >/dev/null)
if ! diff -r "${scratch}/api" ui/src/api; then
  # Put the files back, so the check leaves the working tree as it found it.
  rm -rf ui/src/api
  cp -R "${scratch}/api" ui/src/api
  echo "ui/src/api is stale. Run: just gen" >&2
  exit 1
fi
echo "Generated files are current."
