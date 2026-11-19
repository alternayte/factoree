#!/usr/bin/env bash
# docs/specs/run-workflow-structure.md. A stage of the run workflow takes its differences as
# parameters and never asks which kind of run it serves. A story chooses each value once, so a
# run-kind check in a stage fails here.
set -euo pipefail
cd "$(dirname "$0")/.."
if hits=$(grep -rnE 'PrFollowUpInput|BringCurrentInput|prFollowUp|bringCurrent' src/workflows/agent-run/stages); then
  echo "checks/run-kind.sh: a stage names a run kind. Pass the difference as a parameter from the story." >&2
  echo "${hits}" >&2
  exit 1
fi
echo "checks/run-kind.sh: no stage names a run kind."
