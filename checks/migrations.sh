#!/usr/bin/env bash
# A released migration never changes: an install has applied it already, so an edit reaches no
# database. Each schema change is a new directory in prisma/migrations.
# The script compares each file under prisma/migrations of the latest release tag with the
# working tree. With no release tag yet, nothing is released, so it passes (DI-15.06).
set -euo pipefail
cd "$(dirname "$0")/.."
if ! tag=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null); then
  echo "checks/migrations.sh: no release tag found, so no migration is released. Pass."
  echo "checks/migrations.sh: in CI, fetch the tags first (actions/checkout with fetch-depth: 0)."
  exit 0
fi
bad=0
while read -r file; do
  if [ ! -f "$file" ]; then
    echo "checks/migrations.sh: $file is in release $tag and must not be deleted" >&2
    bad=1
  elif ! git diff --quiet "$tag" -- "$file"; then
    echo "checks/migrations.sh: $file differs from release $tag. Add a new migration instead." >&2
    bad=1
  fi
done < <(git ls-tree -r --name-only "$tag" -- prisma/migrations)
if [ "$bad" -eq 0 ]; then
  echo "checks/migrations.sh: every migration of $tag is unchanged."
fi
exit "$bad"
