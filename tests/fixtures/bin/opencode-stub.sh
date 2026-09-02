#!/bin/sh
# tests/fixtures/bin/opencode-stub.sh
# A deterministic stand-in for the opencode CLI. It proves the runner contract without a model.
# It reads the prompt on standard input, the way the real CLI does, and writes the same JSON event
# stream the CLI writes. The prompt travels in a file the runner pipes here, because Linux carries
# at most 131072 bytes in one environment value and a real Reviewer prompt is larger than that.
set -e
PROMPT=$(/bin/cat)
printf '{"type":"session.start","session":{"id":"ses_stub_1"}}\n'
if [ -n "${FACTOREE_STUB_SLEEP:-}" ]; then
  sleep "$FACTOREE_STUB_SLEEP"
fi
if [ -n "${FACTOREE_STUB_TARGET:-}" ]; then
  printf '%s\n' "$PROMPT" > "$FACTOREE_STUB_TARGET"
fi
if [ -n "${FACTOREE_STUB_PRINT_SECRET:-}" ]; then
  printf '{"type":"message","text":"I printed %s"}\n' "$FACTOREE_STUB_PRINT_SECRET"
else
  printf '{"type":"message","text":"The change is applied."}\n'
fi
exit "${FACTOREE_STUB_EXIT:-0}"
