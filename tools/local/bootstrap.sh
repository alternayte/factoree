#!/usr/bin/env bash
# Registers the Linear installation, the Project, the GITHUB_TOKEN secret, and the two context
# source rows. Reads every value from .env. Run it once, after `just api` starts.
set -euo pipefail

cd "$(dirname "$0")/../.."

while IFS="=" read -r key value; do
    [[ -z "${key}" || -z "${value}" || "${key}" == \#* ]] && continue
    export "${key}=${value}"
done < .env

require() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        echo "Set ${name} in .env first." >&2
        exit 1
    fi
}

for name in ADMIN_API_TOKEN SETUP_LINEAR_WORKSPACE_ID SETUP_LINEAR_ACCESS_TOKEN \
            SETUP_PROJECT_KEY SETUP_GITHUB_REPOSITORY SETUP_GITHUB_TOKEN \
            LIVE_LINEAR_TEAM_ID; do
    require "${name}"
done

API_BASE="${API_BASE:-http://localhost:${PORT:-3000}}"
BACKSTAGE_URL="${SETUP_BACKSTAGE_URL:-http://localhost:${BACKSTAGE_STUB_PORT:-4100}}"
MCP_URL="${SETUP_MCP_URL:-http://localhost:${MCP_STUB_PORT:-4200}}"

api() {
    local method="$1" path="$2" body="$3"
    curl -sS -f -X "${method}" "${API_BASE}${path}" \
        -H "Authorization: Bearer ${ADMIN_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "${body}"
}

query_only="?linearWorkspaceId=${SETUP_LINEAR_WORKSPACE_ID}"

echo "1. The Linear installation."
# A Linear access token lives for twenty-four hours. Store the refresh token and the lifetime as
# well, so the worker refreshes it instead of failing every Run on the next day.
api PUT "/admin/linear-installations" "$(jq -n \
    --arg w "${SETUP_LINEAR_WORKSPACE_ID}" \
    --arg n "${SETUP_WORKSPACE_NAME:-Factoree test workspace}" \
    --arg t "${SETUP_LINEAR_ACCESS_TOKEN}" \
    --arg r "${SETUP_LINEAR_REFRESH_TOKEN:-}" \
    --argjson e "${SETUP_LINEAR_EXPIRES_IN:-null}" \
    '{linearWorkspaceId:$w, workspaceName:$n, accessToken:$t}
     + (if $r == "" then {} else {refreshToken:$r} end)
     + (if $e == null then {} else {expiresIn:$e} end)')"
echo

echo "2. The Project."
existing="$(curl -sS -f "${API_BASE}/admin/projects${query_only}" \
    -H "Authorization: Bearer ${ADMIN_API_TOKEN}" \
    | jq -r --arg k "${SETUP_PROJECT_KEY}" '.[] | select(.key == $k) | .id' | head -1)"
if [[ -n "${existing}" ]]; then
    project_id="${existing}"
    echo "The Project already exists. The script reuses it."
    api PUT "/admin/projects/${existing}${query_only}" "$(jq -n \
        --arg t "${LIVE_LINEAR_TEAM_ID}" \
        --arg repo "${SETUP_GITHUB_REPOSITORY}" \
        '{linearTeamId:$t, primaryRepository:$repo}')" > /dev/null
else
    project="$(api POST "/admin/projects" "$(jq -n \
        --arg w "${SETUP_LINEAR_WORKSPACE_ID}" \
        --arg n "${SETUP_WORKSPACE_NAME:-Factoree test workspace}" \
        --arg k "${SETUP_PROJECT_KEY}" \
        --arg name "${SETUP_PROJECT_NAME:-Live acceptance fixture Project}" \
        --arg repo "${SETUP_GITHUB_REPOSITORY}" \
        --arg team "${LIVE_LINEAR_TEAM_ID}" \
        '{linearWorkspaceId:$w, workspaceName:$n, key:$k, name:$name, primaryRepository:$repo,
          linearTeamId:$team}')")"
    project_id="$(echo "${project}" | jq -r .id)"
fi
echo "Project id: ${project_id}"

echo "3. The GITHUB_TOKEN Project secret."
api PUT "/admin/projects/${project_id}/secrets/GITHUB_TOKEN${query_only}" "$(jq -n \
    --arg v "${SETUP_GITHUB_TOKEN}" '{value:$v, injectIntoImplementer:false, kind:"publish"}')"
echo

# SDD section 30. Each credential carries a kind, and the kind decides which carrier holds the
# value. Neither takes the injection mark, and the API refuses that combination.
if [[ -n "${SETUP_RUNNER_CREDENTIAL:-}" && -n "${SETUP_RUNNER_CREDENTIAL_NAME:-}" ]]; then
    echo "3b. The runner credential ${SETUP_RUNNER_CREDENTIAL_NAME}."
    api PUT "/admin/projects/${project_id}/secrets/${SETUP_RUNNER_CREDENTIAL_NAME}${query_only}" \
        "$(jq -n --arg v "${SETUP_RUNNER_CREDENTIAL}" '{value:$v, kind:"runner_credential"}')"
    echo
fi

if [[ -n "${SETUP_GITHUB_READ_TOKEN:-}" ]]; then
    echo "3c. The read-only repository credential."
    api PUT "/admin/projects/${project_id}/secrets/GITHUB_READ_TOKEN${query_only}" \
        "$(jq -n --arg v "${SETUP_GITHUB_READ_TOKEN}" '{value:$v, kind:"repository_read"}')"
    echo
fi

echo "4. The Backstage context source."
api POST "/admin/projects/${project_id}/context-sources${query_only}" "$(jq -n \
    --arg e "${BACKSTAGE_URL}" \
    '{sourceId:"backstage-catalog", kind:"backstage", endpoint:$e, enabled:true}')"
echo

echo "5. The MCP context source."
api POST "/admin/projects/${project_id}/context-sources${query_only}" "$(jq -n \
    --arg e "${MCP_URL}" \
    --arg d "${SETUP_MCP_DISCOVER_TOOL:-search}" \
    --arg f "${SETUP_MCP_FETCH_TOOL:-fetch}" \
    '{sourceId:"mcp-source", kind:"mcp", endpoint:$e, enabled:true,
      settings:{kind:"mcp", discoverTool:$d, fetchTool:$f}}')"
echo

echo "Bootstrap done. Project id: ${project_id}"
