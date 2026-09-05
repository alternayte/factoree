#!/usr/bin/env bash
# Registers the Linear installation, the GitHub installation, the Product, and the two context
# source rows. Reads every value from .env. Run it once, after `just api` starts.
#
# The GitHub App installation is the only credential path to GitHub. Factoree mints every clone
# credential and every publish credential against it, so this script sets up no GitHub secret.
#
# It does not create a Repository row. Discovery creates that row itself, from the
# `.factoree/config.yaml` file of the fixture repository, once the GitHub App reports the
# repository to Factoree. Add that file to the fixture repository, naming the same
# SETUP_PRODUCT_SLUG and SETUP_LINEAR_TEAM_KEY as below, before you delegate a Run.
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
            SETUP_PRODUCT_SLUG SETUP_LINEAR_TEAM_KEY \
            SETUP_GITHUB_INSTALLATION_ID SETUP_GITHUB_ACCOUNT_LOGIN \
            SETUP_GITHUB_REPOSITORY; do
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

echo "1b. The GitHub installation."
# Discovery only reads a repository once its installation is bound to a tenant. An unbound
# installation event is ignored, not an error, so this bind must happen before the fixture
# repository is pushed to.
api PUT "/admin/github-installations" "$(jq -n \
    --arg w "${SETUP_LINEAR_WORKSPACE_ID}" \
    --arg i "${SETUP_GITHUB_INSTALLATION_ID}" \
    --arg a "${SETUP_GITHUB_ACCOUNT_LOGIN}" \
    '{linearWorkspaceId:$w, githubInstallationId:$i, accountLogin:$a}')"
echo

echo "2. The Product."
existing="$(curl -sS -f "${API_BASE}/admin/products${query_only}" \
    -H "Authorization: Bearer ${ADMIN_API_TOKEN}" \
    | jq -r --arg s "${SETUP_PRODUCT_SLUG}" '.[] | select(.slug == $s) | .id' | head -1)"
if [[ -n "${existing}" ]]; then
    product_id="${existing}"
    echo "The Product already exists. The script reuses it."
else
    product="$(api POST "/admin/products" "$(jq -n \
        --arg w "${SETUP_LINEAR_WORKSPACE_ID}" \
        --arg n "${SETUP_WORKSPACE_NAME:-Factoree test workspace}" \
        --arg s "${SETUP_PRODUCT_SLUG}" \
        --arg name "${SETUP_PRODUCT_NAME:-Live acceptance fixture Product}" \
        --arg team "${SETUP_LINEAR_TEAM_KEY}" \
        '{linearWorkspaceId:$w, workspaceName:$n, slug:$s, name:$name, linearTeamKey:$team}')")"
    product_id="$(echo "${product}" | jq -r .id)"
fi
echo "Product id: ${product_id}"

# A new Product starts pending, at autonomy L0. Activate it, so a delegated Run can proceed past
# refinement. Reusing an existing Product activates it again; the call is idempotent.
api POST "/admin/products/${product_id}/activate${query_only}" "$(jq -n \
    --arg a "${SETUP_DEFAULT_AUTONOMY:-L2}" '{defaultAutonomy:$a}')" > /dev/null

# SDD section 30. Each credential carries a kind, and the kind decides which carrier holds the
# value. It takes no injection mark, and the API refuses that combination.
if [[ -n "${SETUP_RUNNER_CREDENTIAL:-}" && -n "${SETUP_RUNNER_CREDENTIAL_NAME:-}" ]]; then
    echo "3. The runner credential ${SETUP_RUNNER_CREDENTIAL_NAME}."
    api PUT "/admin/products/${product_id}/secrets/${SETUP_RUNNER_CREDENTIAL_NAME}${query_only}" \
        "$(jq -n --arg v "${SETUP_RUNNER_CREDENTIAL}" '{value:$v, kind:"runner_credential"}')"
    echo
fi

echo "4. The Backstage context source."
api POST "/admin/products/${product_id}/context-sources${query_only}" "$(jq -n \
    --arg e "${BACKSTAGE_URL}" \
    '{sourceId:"backstage-catalog", kind:"backstage", endpoint:$e, enabled:true}')"
echo

echo "5. The MCP context source."
api POST "/admin/products/${product_id}/context-sources${query_only}" "$(jq -n \
    --arg e "${MCP_URL}" \
    --arg d "${SETUP_MCP_DISCOVER_TOOL:-search}" \
    --arg f "${SETUP_MCP_FETCH_TOOL:-fetch}" \
    '{sourceId:"mcp-source", kind:"mcp", endpoint:$e, enabled:true,
      settings:{kind:"mcp", discoverTool:$d, fetchTool:$f}}')"
echo

echo "Bootstrap done. Product id: ${product_id}"
