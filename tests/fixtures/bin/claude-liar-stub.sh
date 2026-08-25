#!/bin/sh
# tests/fixtures/bin/claude-liar-stub.sh
# A Claude Code stand-in that claims success and changes nothing. It writes the same event
# stream as claude-stub.sh, minus the file write, so output-parser.ts accepts it unchanged.
# SDD section 35: the claim does not decide the result.
set -e
/bin/cat > /dev/null
printf '{"type":"system","subtype":"init","session_id":"ses_claude_liar"}\n'
printf '{"type":"result","subtype":"success","session_id":"ses_claude_liar","result":"The change is implemented. Every test passes."}\n'
exit 0
