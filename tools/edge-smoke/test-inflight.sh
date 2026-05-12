#!/usr/bin/env bash
# test-inflight.sh — exercise x402-inflight (cap 200 concurrent).
# Opens 250 long-lived connections; ≥25 should not get 2xx.
set -euo pipefail

SHIELD_URL="${SHIELD_URL:-https://devnet.rpcpriority.com}"
CONNS="${CONNS:-250}"
DRY_RUN="false"
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="true"

ENDPOINT="${SHIELD_URL}/rpc"
BODY='{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'

if command -v parallel >/dev/null; then RUNNER="parallel"; else RUNNER="xargs"; fi

[[ "${DRY_RUN}" == "true" ]] && { echo "[dry-run] would issue ${CONNS} via ${RUNNER}"; exit 0; }

TMP="$(mktemp)"; trap 'rm -f "${TMP}"' EXIT
fire_one() { curl -s -o /dev/null --max-time 30 -w '%{http_code} %{time_total}\n' -H 'Content-Type: application/json' --data "${BODY}" "${ENDPOINT}"; }
export -f fire_one
export ENDPOINT BODY

if [[ "${RUNNER}" == "parallel" ]]; then
  seq 1 "${CONNS}" | parallel -j "${CONNS}" --will-cite fire_one >> "${TMP}"
else
  seq 1 "${CONNS}" | xargs -I {} -P "${CONNS}" bash -c 'fire_one' >> "${TMP}"
fi

COUNT_2XX="$(grep -cE '^(200|402)' "${TMP}" || true)"
REJECTED=$(( CONNS - COUNT_2XX ))
echo "2xx: ${COUNT_2XX}, rejected: ${REJECTED}"
[[ "${REJECTED}" -lt 25 ]] && { echo "FAIL: only ${REJECTED} rejected" >&2; exit 1; }
echo "PASS"
