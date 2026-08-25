#!/bin/sh
# tests/fixtures/bin/claude-stub.sh
# A deterministic stand-in for the Claude Code CLI. It proves the runner contract without a model.
# It reads the prompt from standard input and writes the stream-json event stream the CLI writes.
set -e
PROMPT=$(/bin/cat)
printf '{"type":"system","subtype":"init","session_id":"ses_claude_1"}\n'
if [ -n "${FACTOREE_STUB_SLEEP:-}" ]; then
  sleep "$FACTOREE_STUB_SLEEP"
fi
if [ -n "${FACTOREE_STUB_TARGET:-}" ]; then
  printf '%s\n' "$PROMPT" > "$FACTOREE_STUB_TARGET"
fi
if [ -n "${FACTOREE_STUB_PRINT_SECRET:-}" ]; then
  printf '{"type":"result","subtype":"success","session_id":"ses_claude_1","result":"I printed %s"}\n' \
    "$FACTOREE_STUB_PRINT_SECRET"
else
  printf '{"type":"result","subtype":"success","session_id":"ses_claude_1","result":"The change is applied."}\n'
fi
exit "${FACTOREE_STUB_EXIT:-0}"
