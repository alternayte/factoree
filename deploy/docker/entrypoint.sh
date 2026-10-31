#!/bin/sh
# docs/specs/release-0-1-0.md. The commands of the factoree image: api, worker, migrate and --version.
set -eu
cd /app

usage() {
  echo "usage: factoree api | worker | migrate | --version" >&2
}

if [ "$#" -eq 0 ]; then
  usage
  exit 64
fi

command="$1"
shift
case "$command" in
  api)
    exec node dist/bin/api.js "$@"
    ;;
  worker)
    exec node dist/bin/worker.js "$@"
    ;;
  migrate)
    # prisma.config.ts reads FACTOREE_DATABASE_URL, the only database name Prisma needs (DI-15.12).
    if [ -z "${FACTOREE_DATABASE_URL:-}" ]; then
      echo "factoree migrate: set FACTOREE_DATABASE_URL" >&2
      exit 78
    fi
    exec node_modules/.bin/prisma migrate deploy "$@"
    ;;
  --version|version)
    exec node dist/bin/worker.js --version
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "factoree: unknown command: $command" >&2
    usage
    exit 64
    ;;
esac
