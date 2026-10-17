#!/usr/bin/env bash
# PreToolUse hook: deterministically blocks any tool call that could reach
# real emergency services. Fails closed: if input cannot be parsed, the whole
# payload is scanned instead of being allowed through.
input="$(cat)"

# Scan only the tool's arguments so session IDs and paths can't false-match.
if command -v jq >/dev/null 2>&1; then
  args="$(printf '%s' "$input" | jq -c '.tool_input // empty' 2>/dev/null)" || args="$input"
elif command -v python3 >/dev/null 2>&1; then
  args="$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("tool_input","")))' 2>/dev/null)" || args="$input"
else
  args="$input"
fi
[ -z "$args" ] && args="$input"

block() {
  echo "BLOCKED by YPC safety boundary: $1. Real emergency services must never be contacted; use the mock operator endpoint instead." >&2
  exit 2
}

# Emergency numbers as standalone digit runs (911, 112 redirects to 911 on
# mobile, 933 is the 911 address-test line), with optional +1 / 1- prefix.
if printf '%s' "$args" | grep -qE '(^|[^0-9])(\+?1[- .]?)?(911|112|933)([^0-9]|$)'; then
  block "emergency number detected"
fi

# Telephony URIs that place calls or SMS.
if printf '%s' "$args" | grep -qiE '(tel|sip|sips|sms|callto):'; then
  block "telephony URI detected"
fi

# PSTN / outbound-calling providers.
if printf '%s' "$args" | grep -qiE 'twilio|vonage|nexmo|plivo|telnyx|bandwidth\.com|sinch|signalwire|messagebird|vapi\.ai|retellai|bland\.ai|rapidsos'; then
  block "telephony or emergency-dispatch provider detected"
fi

exit 0
