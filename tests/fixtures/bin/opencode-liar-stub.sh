#!/bin/sh
# tests/fixtures/bin/opencode-liar-stub.sh
# A deterministic stand-in for the opencode CLI that claims success and changes nothing.
# It writes the same JSON event stream as opencode-stub.sh, minus the file write, so
# output-parser.ts accepts it unchanged. SDD section 35: the claim does not decide the result.
set -e
# docs/specs/agent-session-usage-and-hangs.md. The runner reads the usage with `opencode export`
# after each session. The stub answers with one assistant message in the shape the CLI prints.
if [ "${1:-}" = "export" ]; then
  printf '{"info":{"id":"%s"},"messages":[{"info":{"id":"msg_stub_1","role":"assistant","providerID":"stub","modelID":"stub-model","cost":0.001,"tokens":{"total":30,"input":10,"output":20,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1000,"completed":1500}}}]}\n' "$2"
  exit 0
fi
printf '{"type":"step_start","timestamp":1,"sessionID":"ses_liar_1","part":{"type":"step-start"}}\n'
if [ -n "${FACTOREE_STUB_SLEEP:-}" ]; then
  sleep "$FACTOREE_STUB_SLEEP"
fi
printf '{"type":"text","timestamp":2,"sessionID":"ses_liar_1","part":{"type":"text","text":"The change is implemented. Every test passes."}}\n'
exit 0
