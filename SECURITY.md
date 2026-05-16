# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `main` branch | ✅ |
| Tagged releases | ✅ (latest minor) |
| Older tags | ❌ |

The reference Shield implementation (`index.js` + `lib/`) and the Trust-Score broker (`broker/`, when extracted) are the security-sensitive components. RFC documents in `docs/rfc/` are normative specifications and any issues with their security properties should be raised via the same channel.

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

### Preferred channels

1. **GitHub Security Advisory** — [open a private advisory](https://github.com/flavioparah/x402-priority-protocol/security/advisories/new). This is the fastest path and is monitored.

2. **Email** — `security@rpcpriority.com` (when established). PGP key will be published at [https://rpcpriority.com/.well-known/security.txt](https://rpcpriority.com/.well-known/security.txt).

### What to include

- Component affected (Shield, Broker, RFC, public site, SDK example)
- Version / commit hash
- Reproduction steps (proof-of-concept code if possible, but please do not publish it)
- Suggested fix or mitigation if you have one
- Whether you want public credit and under what name

### Response timeline

- **24 hours**: acknowledgement of receipt.
- **7 days**: initial assessment + severity rating.
- **30 days**: target for patch release on high-severity issues. Critical issues (e.g., remote code execution, financial exposure of operator escrow) are prioritized for same-week response.

We follow a 90-day responsible-disclosure window from initial report. Earlier public disclosure may be coordinated if the issue is being actively exploited.

## Scope

In-scope:
- Shield: signature verification, nonce replay, escrow accounting, rate-limit bypass, payment validation
- Broker: signature verification on `/attest` and `/report`, score manipulation, sybil-detection bypass
- Cross-operator: federation gossip integrity (when implemented), audit log tamper-resistance
- Public site: standard web vulnerabilities (XSS, CSRF, etc.)

Out-of-scope:
- Solana RPC nodes themselves (upstream) — report to the operator
- Solana protocol issues — report to Solana Labs / Anza
- Third-party SDKs / wallets

## Bounty

No formal bounty program at this time. We acknowledge contributors in the security advisory and the `CHANGELOG.md` when issues are resolved.

## Acknowledgments

(none yet)
