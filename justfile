# The local harness. Every recipe that runs Node puts the Node 24 toolchain first on PATH,
# because the Homebrew `node` on this machine is Node 25 and it is broken.
node_path := "/opt/homebrew/opt/node@24/bin"

# List every recipe. This is the default, so a plain `just` documents itself.
default:
    @just --list

# Install the npm dependencies, then generate the Prisma client.
install:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    npm ci
    export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
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
    export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
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
        [[ -z "${key}" || "${key}" == \#* ]] && continue
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
        [[ -z "${key}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    node --experimental-strip-types --import ./tests/live/register-loader.mjs src/bin/worker.ts

# Start the HTTP API with the local environment file.
api:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{node_path}}:$PATH"
    while IFS="=" read -r key value; do
        [[ -z "${key}" || "${key}" == \#* ]] && continue
        export "${key}=${value}"
    done < .env
    node --experimental-strip-types --import ./tests/live/register-loader.mjs src/bin/api.ts

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

    run_stage lint npm run lint
    run_stage typecheck npm run typecheck
    run_stage unit npm test
    run_stage integration npm run test:integration
    run_stage workflow npm run test:workflow
    run_stage build npm run build

    rm -f "${log}"
    exit "${status}"

# Run the live acceptance scenario against local infrastructure.
live-local:
    PATH="{{node_path}}:$PATH" npm run acceptance:live:local

# Run the live acceptance scenario against every real SDD section 66 dependency.
live:
    PATH="{{node_path}}:$PATH" npm run acceptance:live

# Stop the local PostgreSQL container and delete its named volume.
nuke:
    @echo "WARNING: this command deletes the factoree_postgres_data volume. That data is gone."
    docker compose down --volumes
