---
name: Dispute
about: File a dispute against an attestation, tier, or broker action
title: "[dispute] <category>: <one-line summary>"
labels: governance, dispute
assignees: ''
---

## Dispute category

- [ ] **attestation** — An attestation submitted to the broker appears fraudulent
- [ ] **tier_demotion** — A provider should be demoted from their current tier
- [ ] **broker_action** — A broker operator action (or inaction) was incorrect

## Subject

What is being disputed?

- Attestation `tx_signature`:
- OR Provider `provider_id`:
- OR Broker action (date + description):

## Evidence

Provide concrete evidence. Examples:
- Reference to the attestation in `/audit/:date`
- Comparison with on-chain data (Solana Explorer link)
- Pattern of attestations indicating wash payment / sybil ring
- Public statement by the broker operator that conflicts with §X of governance

## Requested resolution

What outcome are you requesting? (be specific)

## Operator notification

If the dispute targets a specific operator, have you notified them privately first?
- [ ] Yes (date: ____)
- [ ] No (rationale: ____)

## Acknowledgments

- [ ] I have read [BROKER-GOVERNANCE.md](../../BROKER-GOVERNANCE.md) §5
- [ ] My dispute is made in good faith
- [ ] I understand resolution may take up to 14 days
