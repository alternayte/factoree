# The local harness. Every recipe that runs Node puts the Node 24 toolchain first on PATH,
# because the Homebrew `node` on this machine is Node 25 and it is broken.
node_path := "/opt/homebrew/opt/node@24/bin"

# List every recipe. This is the default, so a plain `just` documents itself.
default:
    @just --list

# Install the npm dependencies of the API and of the UI, then generate the Prisma client.
install:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    npm ci
    npm ci --prefix ui
    export FACTOREE_DATABASE_URL="$(grep -m1 '^FACTOREE_DATABASE_URL=' .env | cut -d= -f2-)"
    npm run db:generate

# Start the local PostgreSQL container and wait for it to accept a connection.
up:
    #!/usr/bin/env bash
    set -euo pipefail
    docker compose up -d
    for _ in $(seq 1 30); do
        if docker compose exec -T postgres pg_isready -U factoree -d factoree >/dev/null 2>&1; then
            echo "PostgreSQL accepts a connection."
            exit 0
        fi
        sleep 1
    done
    echo "PostgreSQL did not accept a connection in time." >&2
    exit 1

# Stop the local PostgreSQL container. The named volume stays. Use `just nuke` to delete it.
down:
    docker compose down

# Apply the Prisma migrations to the local PostgreSQL database.
migrate:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    export FACTOREE_DATABASE_URL="$(grep -m1 '^FACTOREE_DATABASE_URL=' .env | cut -d= -f2-)"
    npm run db:migrate

# Start a public tunnel to the local HTTP API, so a real Linear webhook can reach it.
# This recipe uses `ngrok`, because this machine provides `ngrok` and not `cloudflared`.
tunnel:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v ngrok >/dev/null 2>&1; then
        echo "ngrok is not installed. Install it first. Run: brew install ngrok" >&2
        exit 1
    fi
    ngrok http 3000

# Start the Temporal dev server in the foreground.
temporal:
    PATH="{{node_path}}:$PATH" temporal server start-dev

# Start the Backstage stub and the MCP stub together.
stubs:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    while IFS="=" read -r key value; do
        [[ -z "${key}" || -z "${value}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    trap 'kill 0' EXIT
    node --experimental-strip-types tools/local/backstage-stub.ts &
    node --experimental-strip-types tools/local/mcp-stub.ts &
    wait

# Start the Temporal worker with the local environment file.
worker:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    while IFS="=" read -r key value; do
        [[ -z "${key}" || -z "${value}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    npm run build
    node dist/bin/worker.js

# Drive one real Fly Sprite through every sandbox step of a Run, and report each step.
smoke *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    while IFS="=" read -r key value; do
        [[ -z "${key}" || -z "${value}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    npm run build
    node tools/local/sandbox-smoke.mjs {{ARGS}}

# Start the HTTP API and the UI with the local environment file. Until setup ends, the log names
# the one-time setup token. Open FACTOREE_PUBLIC_URL/setup and enter it.
api:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    while IFS="=" read -r key value; do
        [[ -z "${key}" || -z "${value}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    npm run build
    npm run ui:build
    node dist/bin/api.js

# Write the OpenAPI document from the route schemas, then the UI client from the document.
gen:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    npm run build
    node dist/bin/openapi.js > api/openapi.json
    npm --prefix ui run gen:api

# Fail when api/openapi.json or the UI client differs from what `just gen` writes.
gen-check:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    npm run build
    npm run gen:check

# Run the full non-live verification, one stage at a time, with a real aggregate exit code.
verify:
    #!/usr/bin/env bash
    set -uo pipefail
    export PATH="{{node_path}}:$PATH"
    status=0
    log="$(mktemp)"

    run_stage() {
        local name="$1"
        shift
        echo "== ${name} =="
        "$@" >"${log}" 2>&1
        local code=$?
        cat "${log}"
        if [ "${code}" -ne 0 ]; then
            echo "== ${name} failed with exit ${code} =="
            status=1
        fi
    }

    run_stage migrations ./checks/migrations.sh
    run_stage lint npm run lint
    run_stage typecheck npm run typecheck
    run_stage unit npm test
    run_stage build npm run build
    run_stage ui-lint npm run ui:lint
    run_stage ui-build npm run ui:build
    run_stage gen-check npm run gen:check
    run_stage integration npm run test:integration
    run_stage workflow npm run test:workflow

    rm -f "${log}"
    exit "${status}"

# Docker must run. Pass a ref to upgrade from another commit, for example: just upgrade-test v0.1.0
# Migrate a database of the previous release tag, or of REF, to the working tree.
upgrade-test *REF:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    ./scripts/upgrade-test.sh {{REF}}

# Build the factoree image from the working tree as factoree:dev.
image:
    #!/usr/bin/env bash
    set -euo pipefail
    docker build -f deploy/docker/Dockerfile \
        --build-arg VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)-dev" \
        --build-arg COMMIT="$(git rev-parse HEAD)" \
        --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        -t factoree:dev .

# Lint and render the Helm chart.
chart:
    helm lint deploy/helm/factoree
    helm template factoree deploy/helm/factoree >/dev/null

# Run the live acceptance scenario against local infrastructure.
live-local:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    while IFS="=" read -r key value; do
        [[ -z "${key}" || -z "${value}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    npm run acceptance:live:local

# Run the live acceptance scenario against local infrastructure, plus a real Fly Sprite.
live-sprite:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    while IFS="=" read -r key value; do
        [[ -z "${key}" || -z "${value}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    npm run acceptance:live:sprite

# Run the live acceptance scenario against every real SDD section 66 dependency.
live:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    while IFS="=" read -r key value; do
        [[ -z "${key}" || -z "${value}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    npm run acceptance:live

# Stop the local PostgreSQL container and delete its named volume.
nuke:
    @echo "WARNING: this command deletes the factoree_postgres_data volume. That data is gone."
    docker compose down --volumes
