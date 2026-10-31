#!/bin/sh
# tests/fixtures/bin/opencode-stub.sh
# A deterministic stand-in for the opencode CLI. It proves the runner contract without a model.
# It reads the prompt on standard input, the way the real CLI does, and writes the same JSON event
# stream the CLI writes. The prompt travels in a file the runner pipes here, because Linux carries
# at most 131072 bytes in one environment value and a real Reviewer prompt is larger than that.
set -e
# docs/specs/agent-session-usage-and-hangs.md. The runner reads the usage with `opencode export`
# after each session. The stub answers with one assistant message in the shape the CLI prints.
if [ "${1:-}" = "export" ]; then
  printf '{"info":{"id":"%s"},"messages":[{"info":{"id":"msg_stub_1","role":"assistant","providerID":"stub","modelID":"stub-model","cost":0.001,"tokens":{"total":30,"input":10,"output":20,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1000,"completed":1500}}}]}\n' "$2"
  exit 0
fi
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
