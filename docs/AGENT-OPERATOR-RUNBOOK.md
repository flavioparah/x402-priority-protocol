# x402-shield Agent-Operator Runbook

Phase 4 — Admin API, mass-ban guard, hot-reload config, metrics scraping, agent discovery.

Audience: operators and on-call engineers who manage a live `x402-shield` instance.

---

## Table of Contents

1. [Generating an Admin Key](#1-generating-an-admin-key)
2. [Key Rotation — 90-day cadence with 7-day overlap](#2-key-rotation)
3. [Signing a Request — Bash, Node.js, Python](#3-signing-a-request)
4. [Reading the Audit Log](#4-reading-the-audit-log)
5. [Mass-ban Guard and Unblock Procedure](#5-mass-ban-guard-and-unblock-procedure)
6. [Promoting ENFORCEMENT_TIER_MAX from 3 to 4](#6-promoting-enforcement_tier_max-from-3-to-4)
7. [Redis-Down Handling and Escalation](#7-redis-down-handling-and-escalation)
8. [Removing RPC_LOAD_FORCE in Mainnet](#8-removing-rpc_load_force-in-mainnet)

---

## 1. Generating an Admin Key

Every admin operation is authenticated with HMAC-SHA256 over a canonical request string. The secret is a 32-byte (64 hex-char) random value.

**Generate a new key:**

```bash
openssl rand -hex 32
# example output: 7a9f3b1e2d4c5a0f8e7b6d2a1c3f0e9b8a7d6c5b4e3f2a1d0c9b8e7f6a5d4c3b
```

**Choose a key_id:** use the `ops-YYYY-MM` convention so you can tell at a glance which epoch a log entry belongs to.

```
key_id: ops-2026-05
```

**Add to .env:**

```bash
ADMIN_KEYS_JSON='{"ops-2026-05":"7a9f3b1e2d4c5a0f8e7b6d2a1c3f0e9b8a7d6c5b4e3f2a1d0c9b8e7f6a5d4c3b"}'
```

Multiple keys can coexist (required during rotation):

```bash
ADMIN_KEYS_JSON='{"ops-2026-05":"<new>","ops-2026-02":"<old>"}'
```

**Restart the container:**

```bash
docker compose restart x402-shield-mainnet
```

Verify startup: the log line `admin keys loaded n=1` (or `n=2` during overlap) confirms the key is active.

---

## 2. Key Rotation

Rotate every 90 days. A 7-day overlap window allows client-side migration without downtime.

| Day | Action |
|-----|--------|
| Day −7 | Generate `ops-YYYY-MM-NEW`; add it alongside existing key. Both valid. |
| Day 0 | Switch all scripts and cron jobs to use `ops-YYYY-MM-NEW` as `X-Admin-Key-Id`. |
| Day +7 | Remove the old key from `ADMIN_KEYS_JSON`. Restart container. |

**Validation after each step:**

```bash
# Confirm audit log entries use the new actor_key_id
curl -s "http://localhost:13100/admin/abuse-log?limit=5" \
  -H "X-Admin-Key-Id: ops-2026-05-NEW" \
  -H "X-Admin-Timestamp: $(date +%s)" \
  -H "X-Admin-Auth: <sig>" \
  | jq '.entries[0].actor_key_id'
# expected: "ops-2026-05-NEW"
```

If `actor_key_id` still shows the old value, a script has not been migrated.

---

## 3. Signing a Request

The canonical string (§9.2) has exactly 6 newline-separated lines:

```
METHOD
/path/only
sorted_query_string
unix_timestamp_seconds
key_id
sha256hex_of_body
```

- Query parameters are sorted lexicographically by key name.
- Body hash is `sha256("")` for GET/DELETE requests with no body.
- Timestamp must be within ±60 s of the server clock.

### 3.1 Bash + curl

```bash
KEY_ID="ops-2026-05"
SECRET_HEX="7a9f3b1e2d4c5a0f8e7b6d2a1c3f0e9b8a7d6c5b4e3f2a1d0c9b8e7f6a5d4c3b"
BASE_URL="http://localhost:13100"

METHOD="POST"
PATH="/admin/ban"
BODY='{"key":"9nT3...abc","type":"pubkey","tier":3,"reason":"flood detected"}'

TS=$(date +%s)
BODY_SHA=$(printf '%s' "$BODY" | openssl dgst -sha256 -binary | xxd -p -c 256)
CANONICAL=$(printf '%s\n%s\n%s\n%s\n%s\n%s' "$METHOD" "$PATH" "" "$TS" "$KEY_ID" "$BODY_SHA")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$(echo "$SECRET_HEX" | xxd -r -p)" -binary | xxd -p -c 256)

curl -s -X POST "$BASE_URL$PATH" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key-Id: $KEY_ID" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Auth: $SIG" \
  -d "$BODY"
```

> Note: the empty string between `$PATH` and `$TS` is the sorted query string (empty for this POST).

### 3.2 Node.js

```js
const crypto = require("crypto");

const SECRET_HEX = process.env.ADMIN_SECRET_HEX; // 64 hex chars
const KEY_ID     = process.env.ADMIN_KEY_ID;       // e.g. "ops-2026-05"

function sign(method, urlPath, body = "") {
  const u = new URL("http://x" + urlPath);
  const sortedQuery = [...u.searchParams.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const ts = Math.floor(Date.now() / 1000);
  const bodySha = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method, u.pathname, sortedQuery, String(ts), KEY_ID, bodySha].join("\n");
  const sig = crypto
    .createHmac("sha256", Buffer.from(SECRET_HEX, "hex"))
    .update(canonical)
    .digest("hex");
  return { ts, sig };
}

// Worked example — ban a pubkey
const body = JSON.stringify({ key: "9nT3...abc", type: "pubkey", tier: 3, reason: "flood" });
const { ts, sig } = sign("POST", "/admin/ban", body);

const r = await fetch("http://localhost:13100/admin/ban", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Admin-Key-Id": KEY_ID,
    "X-Admin-Timestamp": String(ts),
    "X-Admin-Auth": sig,
  },
  body,
});
console.log(r.status, await r.json());
```

### 3.3 Python 3

```python
import hashlib, hmac, time, json, urllib.parse, requests, os

SECRET_HEX = os.environ["ADMIN_SECRET_HEX"]
KEY_ID     = os.environ["ADMIN_KEY_ID"]

def sign(method: str, url_path: str, body: str = "") -> dict:
    parsed = urllib.parse.urlparse("http://x" + url_path)
    params = sorted(urllib.parse.parse_qsl(parsed.query))
    sorted_query = "&".join(f"{k}={v}" for k, v in params)
    ts = int(time.time())
    body_sha = hashlib.sha256(body.encode()).hexdigest()
    canonical = "\n".join([method, parsed.path, sorted_query, str(ts), KEY_ID, body_sha])
    sig = hmac.new(bytes.fromhex(SECRET_HEX), canonical.encode(), hashlib.sha256).hexdigest()
    return {"ts": ts, "sig": sig}

# Worked example — unban a pubkey
body = json.dumps({"key": "9nT3...abc", "type": "pubkey", "reason": "false positive"})
auth = sign("POST", "/admin/unban", body)

r = requests.post(
    "http://localhost:13100/admin/unban",
    headers={
        "Content-Type": "application/json",
        "X-Admin-Key-Id": KEY_ID,
        "X-Admin-Timestamp": str(auth["ts"]),
        "X-Admin-Auth": auth["sig"],
    },
    data=body,
)
print(r.status_code, r.json())
```

---

## 4. Reading the Audit Log

**Endpoint:** `GET /admin/abuse-log?limit=50&since=<unix_ts>`

**Response shape:**

```json
{
  "entries": [
    {
      "ts": 1746825600,
      "actor_key_id": "ops-2026-05",
      "method": "POST",
      "path": "/admin/ban",
      "body_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "target": { "key": "9nT3...abc", "type": "pubkey" },
      "action": "ban",
      "action_outcome": "ok",
      "request_id": "req-abc123"
    }
  ]
}
```

### Forensic HMAC recompute

Given a log entry and the epoch's secret, reproduce the signature to confirm authenticity:

```bash
# Inputs from the audit log entry
TS=1746825600
KEY_ID="ops-2026-05"
PATH_ONLY="/admin/ban"
SORTED_QUERY=""
# Reconstruct the original body from body_sha256 is not possible, but you can verify
# a captured body: recalculate body_sha256 and compare.
BODY='{"key":"9nT3...abc","type":"pubkey","tier":3,"reason":"flood detected"}'
BODY_SHA=$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $2}')

CANONICAL=$(printf '%s\n%s\n%s\n%s\n%s\n%s' "POST" "$PATH_ONLY" "$SORTED_QUERY" "$TS" "$KEY_ID" "$BODY_SHA")
printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$(echo "$SECRET_HEX" | xxd -r -p)"
```

Compare the output against the `X-Admin-Auth` value logged in your proxy access log.

### Common patterns to watch for

| `action_outcome` | What it means | Action required |
|------------------|---------------|-----------------|
| `throttled_mass_ban` | Rate limit triggered — too many ban requests | Investigate operator script; review for bugs |
| `ban` + `tier=4` | Permanent ban applied | High scrutiny; ensure supporting evidence exists |
| Repeated `unban` for same key | Possible oscillation | Human review; check if automated script is looping |
| `store_unavailable` reason | Redis was down during a ban attempt | Confirm Redis health; retry after recovery |

---

## 5. Mass-ban Guard and Unblock Procedure

The guard has two tiers, both enforced in `massBanGuard` middleware before the ban write:

| Tier | Limit | Window | Redis key |
|------|-------|--------|-----------|
| Per key_id | 10 bans | 60 s | `rl:massban:keyid:<key_id>` |
| Global | 50 bans | 3600 s | `rl:massban:global` |

### When the 11th ban-per-key triggers (429)

The guard returns `429` with `Retry-After: 60`. The operator script should back off for at least 60 s and then resume. No Redis action is needed — the 60 s window expires naturally.

```json
{
  "error": "mass_ban_guard_triggered",
  "code": 429,
  "guard": "per_key",
  "per_key_count": 11,
  "global_count": 4,
  "per_key_max": 10,
  "global_max": 50
}
```

### When the 51st global ban-per-hour triggers

This is a hard stop. Natural expiry takes up to 1 hour. If an emergency requires immediate resumption, a second operator must approve and flush the key directly in Redis:

```bash
# Requires second-operator approval. Document in incident log before running.
redis-cli DEL rl:massban:global
```

The flush resets the global window. The next ban request will start a new 1-hour window at count = 1.

**Important:** never silence a `throttled_mass_ban` audit entry. It is your forensic record that the guard fired. Do not delete it from the audit log.

### Checking current counter values

```bash
redis-cli GET rl:massban:global
redis-cli GET "rl:massban:keyid:ops-2026-05"
```

(Values are stored as plain integers with TTL-based expiry.)

---

## 6. Promoting ENFORCEMENT_TIER_MAX from 3 to 4

Tier 4 represents permanent ban. The four conditions required before promotion (Section 8.1):

1. At least 30 days of Tier 3 stable operation — zero false-positives on score ≥ 50.
2. Manual audit of `/admin/abuse-log` by two independent operators.
3. `POST /admin/config` with `meta.manual_promotion: true` in the request body.
4. `test/permanent-ban-promotion.test.js` passing on the mirror/staging environment.

### Worked example — promote

```bash
BODY='{"updates":{"ENFORCEMENT_TIER_MAX":4},"reason":"30-day Tier-3 audit clean — 2 operators signed off","meta":{"manual_promotion":true}}'

TS=$(date +%s)
BODY_SHA=$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $2}')
CANONICAL=$(printf '%s\n%s\n%s\n%s\n%s\n%s' "POST" "/admin/config" "" "$TS" "$KEY_ID" "$BODY_SHA")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$(echo "$SECRET_HEX" | xxd -r -p)" | awk '{print $2}')

curl -s -X POST "http://localhost:13100/admin/config" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key-Id: $KEY_ID" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Auth: $SIG" \
  -d "$BODY"
```

Expected response:

```json
{
  "applied": ["ENFORCEMENT_TIER_MAX"],
  "config": { "ENFORCEMENT_TIER_MAX": 4, "RATE_IP_LIMIT": 100 }
}
```

### Rollback

```bash
BODY='{"updates":{"ENFORCEMENT_TIER_MAX":3},"reason":"rollback after false-positive review"}'
# sign and POST as above
```

Rollback does not require `manual_promotion` because it is a downgrade, not an upgrade. The guard only fires on `ENFORCEMENT_TIER_MAX` increasing to 4.

---

## 7. Redis-Down Handling and Escalation

### Detection

Monitor the `x402_store_healthy` Prometheus gauge. Alert condition:

```
x402_store_healthy == 0 for >= 30s
```

### What still works without Redis

- `GET /health` — always responds (memory health flag set to false).
- `GET /info`
- `GET /agent/code-of-conduct`
- `GET /agent/status` — serves from 10 s in-memory cache; queries degrade to local memory.
- `GET /metrics` — always available; shows `x402_store_healthy 0`.
- `/rpc` unauthenticated traffic — passes through with degraded local rate-limit only.

### What fails-closed

| Operation | Behavior |
|-----------|----------|
| Deposit verify | 503 (cannot confirm payment) |
| `POST /admin/ban` | 503 from massBanGuard (store unavailable) |
| `POST /admin/unban` | 503 |
| `POST /admin/config` | 503 if config module requires store persistence |
| Escrow read | 503 |

### Escalation ladder

1. Container restart — clears transient connection pool issues.
2. Fail over to secondary Redis (if HA replica configured).
3. Memory-only mode — set `REDIS_REQUIRED=false` and restart. Rate-limiting falls back to in-process memory (single-instance only; no cross-pod sharing).

---

## 8. Removing RPC_LOAD_FORCE in Mainnet

`RPC_LOAD_FORCE_MAINNET` is a Phase 3 bootstrap variable that forces the RPC load gate into a specific state. It must be removed before Phase 3 rollout is considered complete.

### Validate current state

```bash
curl -s http://localhost:13100/health | jq '.load_forced'
# Must return: false
# If it returns: true — the env var is still set.
```

### Remove the variable

1. Edit `.env` and remove (or comment out) `RPC_LOAD_FORCE_MAINNET`.
2. Recreate the container (do not just restart — env vars are baked at container creation):

```bash
docker compose down x402-shield-mainnet
docker compose up -d x402-shield-mainnet
```

3. Re-validate:

```bash
curl -s http://localhost:13100/health | jq '.load_forced'
# expected: false
```

---

## Endpoint Quick Reference

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | None | Liveness + store health |
| `/metrics` | GET | None (firewall-restricted) | Prometheus scrape |
| `/agent/code-of-conduct` | GET | None | API usage policy (HTML or JSON) |
| `/agent/status` | GET | None | Per-pubkey tier + ban status (10 s cache) |
| `/admin/abuse-log` | GET | HMAC | Read audit log entries |
| `/admin/ban` | POST | HMAC | Ban a key/IP/pubkey |
| `/admin/unban` | POST | HMAC | Remove a ban |
| `/admin/config` | GET | HMAC | Read current hot-reloadable config |
| `/admin/config` | POST | HMAC | Apply config updates (hot-reload) |

### /metrics scraping example

```bash
curl -s http://localhost:13100/metrics | grep x402_
```

Key gauges:

```
x402_store_healthy 1
x402_requests_total{route="rpc",outcome="ok"} 1024
x402_admin_actions_total{action="ban",outcome="ok"} 7
x402_rate_limit_hits_total{dimension="ip"} 42
```

### /agent/code-of-conduct

```bash
# JSON
curl -H "Accept: application/json" http://localhost:13100/agent/code-of-conduct

# HTML (for browser / AI agent discovery)
curl http://localhost:13100/agent/code-of-conduct
```

### /agent/status

```bash
# Check tier and ban status for a specific pubkey
curl "http://localhost:13100/agent/status?pubkey=9nT3...abc"
```

Response:

```json
{
  "pubkey": "9nT3...abc",
  "tier": 2,
  "banned": false,
  "ban_type": null,
  "cached": true,
  "cache_age_s": 4
}
```

Cache TTL is 10 s. To force a fresh read, use `/admin/agent/:pubkey` (bypasses cache — requires HMAC auth).
