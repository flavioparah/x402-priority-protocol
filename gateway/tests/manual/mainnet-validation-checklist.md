# x402-Shield — Mainnet Validation Checklist

## Objective

Validate the x402-Shield gateway under controlled Solana Mainnet conditions without exposing private keys, seed phrases, treasury wallets, or production infrastructure secrets.

## Safety Rules

- Do not print private keys.
- Do not print seed phrases.
- Do not commit `.env`.
- Do not run real payment transactions unless `MAINNET_SEND_TX=true`.
- Use low-value payments only.
- Prefer read-only RPC methods during dry-run.
- Record actual results honestly.
- Mark unexecuted tests as `NOT RUN`.

## Environment

| Field | Value |
|---|---|
| Project | x402-Shield |
| Network | Solana Mainnet |
| Gateway URL | `<fill>` |
| REAL_RPC_URL | `<redacted>` |
| PAYMENT_DESTINATION | `<fill>` |
| Redis Enabled | `<yes/no>` |
| Commit Hash | `<fill>` |
| Date | `<fill>` |
| Operator | `<fill>` |

## Required Environment Variables

```env
NODE_ENV=production
NETWORK=solana-mainnet
REAL_RPC_URL=
PAYMENT_DESTINATION=
REDIS_URL=
BASE_PRICE_LAMPORTS=
MAX_BATCH_SIZE=50
MAX_PAYLOAD_BYTES=1048576
QOS_WEIGHT_TURBO=5
QOS_WEIGHT_PAID=2
QOS_WEIGHT_NORMAL=1
MAINNET_SEND_TX=false
```

## Test Categories

### 1. Health Check

| Test ID     | Test           | Expected           | Status  |
| ----------- | -------------- | ------------------ | ------- |
| MAINNET-001 | GET /health    | 200 OK             | NOT RUN |
| MAINNET-002 | GET /stats/qos | 200 OK, no secrets | NOT RUN |

### 2. Read-Only RPC

| Test ID     | Test                     | Expected                 | Status  |
| ----------- | ------------------------ | ------------------------ | ------- |
| MAINNET-010 | getHealth                | Success or 402 challenge | NOT RUN |
| MAINNET-011 | getBlockHeight           | Success or 402 challenge | NOT RUN |
| MAINNET-012 | getBalance public wallet | Success or 402 challenge | NOT RUN |

### 3. x402 Challenge

| Test ID     | Test                           | Expected                           | Status  |
| ----------- | ------------------------------ | ---------------------------------- | ------- |
| MAINNET-020 | Trigger high load/backpressure | 402 Payment Required               | NOT RUN |
| MAINNET-021 | Verify challenge headers       | Destination, amount, nonce, expiry | NOT RUN |
| MAINNET-022 | Validate required amount       | Matches method pricing             | NOT RUN |

### 4. Proof Integrity

| Test ID     | Test                        | Expected      | Status  |
| ----------- | --------------------------- | ------------- | ------- |
| MAINNET-030 | Use proof with same body    | Accepted once | NOT RUN |
| MAINNET-031 | Reuse same proof            | Rejected      | NOT RUN |
| MAINNET-032 | Use proof with changed body | Rejected      | NOT RUN |
| MAINNET-033 | Use devnet proof on mainnet | Rejected      | NOT RUN |

### 5. Batch RPC

| Test ID     | Test                        | Expected                | Status  |
| ----------- | --------------------------- | ----------------------- | ------- |
| MAINNET-040 | Batch with 3 cheap calls    | Charged sum correctly   | NOT RUN |
| MAINNET-041 | Batch with expensive method | Charged high multiplier | NOT RUN |
| MAINNET-042 | Batch with 51 items         | Rejected                | NOT RUN |

### 6. Payload Limit

| Test ID     | Test              | Expected               | Status  |
| ----------- | ----------------- | ---------------------- | ------- |
| MAINNET-050 | Payload under 1MB | Accepted or challenged | NOT RUN |
| MAINNET-051 | Payload over 1MB  | 413 Payload Too Large  | NOT RUN |

### 7. Deposit Protection

| Test ID     | Test                        | Expected                    | Status  |
| ----------- | --------------------------- | --------------------------- | ------- |
| MAINNET-060 | Invalid base58 signature    | Rejected locally            | NOT RUN |
| MAINNET-061 | 6 invalid deposits / 10 min | 429 rate limited            | NOT RUN |
| MAINNET-062 | Valid deposit signature     | Verified only if configured | NOT RUN |

### 8. Upstream Failure

| Test ID     | Test                 | Expected            | Status  |
| ----------- | -------------------- | ------------------- | ------- |
| MAINNET-070 | Invalid REAL_RPC_URL | Controlled error    | NOT RUN |
| MAINNET-071 | Slow upstream        | Timeout, no crash   | NOT RUN |
| MAINNET-072 | Upstream 500         | Controlled response | NOT RUN |

## Final Recommendation

Choose one:

* `NOT READY`
* `READY FOR DEMO`
* `READY FOR CONTROLLED BETA`
* `READY FOR CONTROLLED MAINNET TESTING`
* `READY FOR OPEN PRODUCTION`

## Honest Conclusion

Write only what was actually verified.
