---
name: Provider tier promotion request
about: Request promotion of a provider from alpha → beta or beta → production
title: "[tier-promotion] <provider_id>: <current_tier> → <target_tier>"
labels: governance, provider-lifecycle
assignees: ''
---

## Provider

- `provider_id`:
- Current tier: alpha / beta
- Target tier: beta / production
- Date of last tier change:

## Criteria check

For `alpha → beta` (30 days without disputes):

- [ ] Provider has been in `alpha` for ≥30 calendar days
- [ ] No disputes filed against this provider in the period

For `beta → production` (90 days at beta + ≥1 cross-op signal):

- [ ] Provider has been in `beta` for ≥90 calendar days
- [ ] Provider has ≥1 attestation that contributed to a cross-op reputation event queried by another provider
- [ ] No disputes filed against this provider in the period

## Cross-op signal evidence (production tier only)

Link to the `/audit/:date` query or the cross-op attestation evidence.

## Acknowledgments

- [ ] I have read [BROKER-GOVERNANCE.md](../../BROKER-GOVERNANCE.md) §3
- [ ] I understand that promotion will trigger weight recomputation across the network
