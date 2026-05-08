#!/usr/bin/env bash
# test-ratelimit.sh — exercise Traefik middleware x402-ratelimit.
# Spec §5. Expects 30 req/s sustained, burst 60. Sends 120 requests as fast
# as possible → at least the 61st should be throttled with HTTP 429 + Retry-After.
set -euo pipefail

SHIELD_URL="${SHIELD_URL:-https://devnet.rpcpriority.com}"
TOTAL="${TOTAL:-120}"
DRY_RUN="false"
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="true"

ENDPOINT="${SHIELD_URL}/health"
echo "Target:   ${ENDPOINT}"
echo "Requests: ${TOTAL} (burst, parallel via &)"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[dry-run] would issue ${TOTAL} parallel curls to ${ENDPOINT}"
  exit 0
fi

TMP="$(mktemp)"; trap 'rm -f "${TMP}"' EXIT

for i in $(seq 1 "${TOTAL}"); do
  curl -s -o /dev/null -w '%{http_code} %header{retry-after}\n' "${ENDPOINT}" >> "${TMP}" &
done
wait

COUNT_429="$(grep -c '^429' "${TMP}" || true)"
RETRY_AFTER="$(grep '^429' "${TMP}" | head -1 | awk '{print $2}')"

echo "429 count: ${COUNT_429}"
echo "Retry-After: ${RETRY_AFTER:-<missing>}"

[[ "${COUNT_429}" -lt 1 ]] && { echo "FAIL: 0 throttled" >&2; exit 1; }
[[ -z "${RETRY_AFTER}" ]] && { echo "FAIL: 429 missing Retry-After" >&2; exit 2; }
echo "PASS"
