#!/usr/bin/env bash
# test-bodylimit.sh — exercise Traefik middleware x402-bodylimit.
# 65 KiB body → 413; 32 KiB body → 200/402 passthrough.
set -euo pipefail

SHIELD_URL="${SHIELD_URL:-https://devnet.rpcpriority.com}"
DRY_RUN="false"
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="true"

ENDPOINT="${SHIELD_URL}/rpc"
BIG="$(mktemp)"; SMALL="$(mktemp)"
trap 'rm -f "${BIG}" "${SMALL}"' EXIT

python3 -c 'import json,sys; sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"getHealth","params":["x"*65000]}))' > "${BIG}"
python3 -c 'import json,sys; sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"getHealth","params":["x"*32000]}))' > "${SMALL}"

if [[ "${DRY_RUN}" == "true" ]]; then echo "[dry-run] $(wc -c < "${BIG}") bytes vs $(wc -c < "${SMALL}")"; exit 0; fi

BIG_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --data-binary "@${BIG}" -H 'Content-Type: application/json' "${ENDPOINT}")"
SMALL_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --data-binary "@${SMALL}" -H 'Content-Type: application/json' "${ENDPOINT}")"

echo "Big: ${BIG_STATUS}, Small: ${SMALL_STATUS}"
[[ "${BIG_STATUS}" != "413" ]] && { echo "FAIL: big should be 413, got ${BIG_STATUS}" >&2; exit 1; }
[[ "${SMALL_STATUS}" != "200" && "${SMALL_STATUS}" != "402" ]] && { echo "FAIL: small should pass (200/402), got ${SMALL_STATUS}" >&2; exit 2; }
echo "PASS"
