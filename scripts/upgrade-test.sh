#!/usr/bin/env bash
# Migrate a database of the previous release to the working tree, then check that the migrated
# database matches prisma/schema.prisma. It starts a throwaway PostgreSQL 16 container, so Docker
# must run. Run `npm ci` first.
#   scripts/upgrade-test.sh          from the release tag before HEAD
#   scripts/upgrade-test.sh <ref>    from any commit, tag or branch
# With no previous release tag, nothing can be upgraded, so it passes with a message (DI-15.07).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -ge 1 ]; then
  from="$1"
else
  # HEAD^ so that the commit of a release tag upgrades from the release before it.
  if ! from=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' HEAD^ 2>/dev/null); then
    echo "upgrade-test: no release tag before HEAD, so there is no release to upgrade from. Pass."
    exit 0
  fi
fi
git rev-parse --verify --quiet "${from}^{commit}" >/dev/null || {
  echo "upgrade-test: $from is not a commit" >&2
  exit 1
}

# The old migrations go inside the repository, so that the old prisma.config.ts resolves the
# prisma package from node_modules.
work="build/upgrade/$(git rev-parse --short "${from}^{commit}")"
rm -rf "$work"
mkdir -p "$work"
git archive "$from" prisma prisma.config.ts | tar -x -C "$work"

container="factoree-upgrade-test-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
docker run -d --name "$container" -e POSTGRES_USER=factoree -e POSTGRES_PASSWORD=factoree \
  -e POSTGRES_DB=factoree -p 127.0.0.1::5432 postgres:16 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U factoree -d factoree >/dev/null 2>&1; then break; fi
  sleep 1
done
port=$(docker port "$container" 5432/tcp | head -n 1 | sed 's/.*://')
url="postgresql://factoree:factoree@127.0.0.1:${port}/factoree"
# prisma.config.ts reads DATABASE_URL before the FACTOREE_ rename and FACTOREE_DATABASE_URL after.
export DATABASE_URL="$url" FACTOREE_DATABASE_URL="$url"

echo "upgrade-test: apply the migrations of $from"
(cd "$work" && npx --no-install prisma migrate deploy)

echo "upgrade-test: apply the migrations of the working tree"
npx --no-install prisma migrate deploy

echo "upgrade-test: compare the migrated database with prisma/schema.prisma"
if ! npx --no-install prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code; then
  echo "upgrade-test: the database after the upgrade from $from differs from prisma/schema.prisma" >&2
  exit 1
fi
echo "upgrade-test: the upgrade from $from passes."
