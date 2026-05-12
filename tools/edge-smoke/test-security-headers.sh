#!/usr/bin/env bash
# test-security-headers.sh — exercise Traefik middleware x402-headers.
set -euo pipefail

SHIELD_URL="${SHIELD_URL:-https://devnet.rpcpriority.com}"
DRY_RUN="false"
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="true"

ENDPOINT="${SHIELD_URL}/health"
[[ "${DRY_RUN}" == "true" ]] && { echo "[dry-run] curl -sI ${ENDPOINT}"; exit 0; }

H="$(mktemp)"; trap 'rm -f "${H}"' EXIT
curl -sI "${ENDPOINT}" | awk '{print tolower($0)}' > "${H}"
FAIL=0

check_present() {
  if grep -qE "^${1}: ${2}" "${H}"; then echo "OK    ${1}"; else echo "FAIL  ${1}"; FAIL=1; fi
}
check_absent_or_empty() {
  local line; line="$(grep -E "^${1}:" "${H}" || true)"
  if [[ -z "${line}" ]]; then echo "OK    ${1}: absent"; return; fi
  local v="$(echo "${line#*:}" | tr -d '[:space:]')"
  if [[ -z "${v}" ]]; then echo "OK    ${1}: empty"; else echo "FAIL  ${1}: leaked ${v}"; FAIL=1; fi
}

check_present "strict-transport-security" "max-age=31536000.*includesubdomains"
check_present "x-content-type-options" "nosniff"
check_present "referrer-policy" "strict-origin-when-cross-origin"
check_present "x-xss-protection" "1; mode=block"
check_absent_or_empty "server"
check_absent_or_empty "x-powered-by"

[[ "${FAIL}" -eq 0 ]] && { echo "PASS"; exit 0; } || exit 1
