# Broker Governance

> **For:** RPC operators considering joining the cross-op network, Solana ecosystem stakeholders, and anyone evaluating whether the Trust-Score Broker is trustworthy as a neutral coordinator.
> **Status:** Phase 1 of cross-op roadmap. v1.0 effective 2026-05-15. Comment window open via GitHub Issues until the federation transition (Phase 5+).

---

## 1. Why this document exists

The Trust-Score Broker is a neutral aggregator of cross-operator reputation. For the broker to be **trusted as neutral** by operators that compete with each other, the rules governing it must be public, predictable, and changeable only through a transparent process.

This document is the contract between the broker operator and everyone else: operators that submit attestations, clients that consume reputation scores, and ecosystem stakeholders that need to evaluate whether the broker is acting in good faith.

If you find a gap between what this document says and what the broker actually does, file an issue using the dispute template at `.github/ISSUE_TEMPLATE/dispute.md`. That gap is a bug in either the documentation or the implementation — both are governance failures.

---

## 2. Who runs the broker

### 2.1 Today

The broker is operated by **RPC Priority Protocol** — the team that wrote the reference implementation and ships it under open source. Single-broker deployment at `broker.x402.network` (to be set up — currently scaffold only; see `broker/README.md`).

Operational responsibilities held by the broker operator today:

- Provisioning and uptime of `broker.x402.network`
- Provider registration via admin CLI
- Triage of disputes filed against attestations, tiers, or broker actions
- Publication of the audit log, weight policy, and incident reports
- Maintenance of the open-source reference implementation

### 2.2 Intent

Transition to **federated brokers** (multiple independent operators each running a peer) once both conditions hold:

1. **≥3 operators are live** on the network and attesting in production
2. **A credible neutral party** wants to operate a broker — for example, a Solana Foundation grantee, a consortium of operators, or a dedicated infra provider with no conflict of interest

The federation spec is deferred to RFC v1.1. Until those conditions are met, federation would be coordination overhead without proportional benefit.

### 2.3 Why centralized today

Federation requires real-world coordination among operators, not just spec design. Building a gossip protocol, peer sync, and reconciliation logic before there is anyone to federate with is overengineering.

The 5-criterion cross-op gate (per the roadmap §1: broker standalone, ≥2 operators, cross-op signals firing, `active_in_n_providers ≥ 2`, `cross_provider_bonus` applied in production) must be met first. Until then, a single trusted broker with public governance is the right tradeoff between trust and coordination cost.

The broker operator commits to publishing federation transition criteria publicly before federation is activated, so operators can verify that the transition is happening on schedule, not being indefinitely deferred.

---

## 3. Provider lifecycle (alpha → beta → production)

Per RFC v0.2 §5.2, every provider sits in exactly one of three tiers. The tier determines a `tier_base` multiplier that is applied to the provider's weight in cross-op reputation calculations.

| Tier | `tier_base` (weight multiplier) | Promotion criteria |
|---|---|---|
| `alpha` | 0.5 | Initial tier after admin registration. Any new operator starts here. |
| `beta` | 1.0 | 30 calendar days without disputes filed by other operators or by the broker. |
| `production` | 1.5 | 90 calendar days at `beta` + ≥1 cross-op signal in good standing (i.e., the operator's attestations have contributed to at least one cross-operator reputation event that another operator queried). |

### 3.1 Promotion mechanics

Promotion is **automatic when criteria are met**. The broker runs a daily job that evaluates all `alpha` and `beta` providers against the criteria and promotes any that qualify. Promotion events are written to the audit log and announced in the quarterly governance report.

The broker operator can **pause auto-promotion** during incident response — for example, while investigating a coordinated burst that may implicate multiple operators. Pauses are documented as broker actions and are themselves disputable (see §5.3). A pause cannot last more than 14 calendar days without a public incident report justifying the extension.

### 3.2 Demotion mechanics

Demotion is **manual via dispute** (§5.2). The broker operator does not unilaterally demote providers. Anyone can file a tier-demotion dispute; the broker operator investigates within 14 days and decides with public rationale. The decision is itself disputable (§5.3).

A provider whose tier is demoted has all in-flight attestations re-weighted using the new `tier_base` at the next score recomputation cycle (typically within 1 hour).

### 3.3 Status independence

Tier and active-cohort membership are independent. A `production`-tier provider that has not attested in `active_window_days` (default 7) is no longer in the active cohort for that window, even though their tier is unchanged. Tier captures earned trust over time; active-cohort captures recent participation.

---

## 4. Weight policy parameters (change window)

The provider weight formula (RFC §5.2.3) is tunable via four governance parameters. All four are published in `GET /info` under the `provider_weight_policy` block, and any change goes through the procedure below.

| Parameter | Default | What it gates |
|---|---|---|
| `pubkey_reach_threshold` | 25 | Minimum distinct pubkeys attested in the last 30 days for an operator to join the active cohort used in median calculations. Below this, the operator is treated as inactive for cohort statistics. |
| `cap_multiple_of_active_median` | 3 | Maximum weight any single operator can hold, expressed as a multiple of the active-cohort median weight. Prevents one large operator from dominating cross-op scores. |
| `floor_weight` | 0.3 | Minimum weight for production-tier operators in good standing. Prevents new but legitimate operators from being weighted to irrelevance during ramp-up. |
| `active_window_days` | 7 | An operator is "recently active" — and counted in the active cohort — if it attested within this many calendar days. |

### 4.1 Change procedure

Any change to any of these parameters follows this five-step process:

1. **Proposal.** Any operator or community member files a GitHub issue using the `weight-policy-change.md` template. The issue must specify the parameter, the current value, the proposed value, and an impact analysis.

2. **Comment window.** 7 calendar days minimum. The issue is pinned on the repository for the duration of the window. The broker operator promotes the issue in the next governance newsletter or operator broadcast, whichever comes first.

3. **Operator response.** The broker operator responds publicly on the issue with rationale: accept, reject, or modify. If modified, the modified version restarts a 7-day comment window only if the modification is material (i.e., changes the parameter value, not just a typo correction).

4. **Effective date.** At least 7 calendar days after acceptance, so operators can recompute scores under the new policy and adjust their own caching, alerting, and downstream consumers. The effective date is published on the resolved issue and in the next `GET /info` response after the change lands.

5. **Audit trail.** The previous values are preserved in the `GET /info` change history block (implementation lands in WS-H part 2 — until then, the changelog at the bottom of this document is the canonical record).

### 4.2 Emergency changes

A parameter change is "emergency" if delaying the change by 7 days would cause an active incident — for example, a parameter value that is currently enabling sybil attacks or weighting a known-malicious operator.

Emergency changes may skip the comment window with public **post-hoc justification** within 48 hours, including:

- The incident that triggered the emergency
- The parameter change made
- The duration of the emergency state
- The plan to restore normal governance (either retain the emergency change permanently after public review, or revert)

Emergency changes are themselves disputable (§5.3). The broker operator commits to using this mechanism sparingly — repeated emergency changes within a 90-day window are a signal that the normal change procedure is broken and should itself be revised.

---

## 5. Dispute mechanism

Three classes of disputes, all resolved via public GitHub issues using the `dispute.md` template.

### 5.1 Attestation dispute

An operator believes another operator's attestation is fraudulent. Common examples:

- Wash payment (operator attesting to payments it controlled both sides of)
- Reused signature across attestations
- Attestation referencing an on-chain transaction that does not exist or does not match the claimed amount

File via `dispute.md` with category `attestation`. The broker operator investigates **within 7 calendar days** and decides one of:

- **No action.** Posts rationale on the issue, including the evidence reviewed.
- **Mark attestation as suspect.** The attestation's contribution to weight is reduced by 50% pending resolution. Other operators are notified via the audit log.
- **Remove attestation.** The attestation is voided, scores recomputed, and the affected operator is notified. If a pattern is established, a tier-demotion dispute (§5.2) may be opened separately.

### 5.2 Tier demotion request

An operator believes another operator should be demoted (e.g., from `production` back to `beta` or `alpha`). Common examples:

- Pattern of suspicious attestations not rising to the level of any single proven fraud, but collectively indicating bad faith
- Sustained operator misbehavior outside the attestation pipeline (e.g., operating multiple shield instances under a single `provider_id` against the spec)
- Operator has not responded to legitimate disputes filed against them

File via `dispute.md` with category `tier_demotion`. The broker operator investigates **within 14 calendar days** and decides with public rationale. The longer window vs. attestation disputes reflects that demotion is a heavier action that warrants deeper review.

### 5.3 Broker action dispute

An operator or community member believes the broker operator's action (or inaction) was incorrect. Common examples:

- Disagreement with an earlier dispute resolution
- Disagreement with an emergency weight policy change
- Belief that the broker operator is acting with conflict of interest (see §8)
- Broker operator failed to meet a publication commitment from §6

File via `dispute.md` with category `broker_action`. The broker operator **must respond within 7 calendar days** with public rationale. The response may be: agreement and remediation, disagreement with reasoning, or commitment to a deeper review with a published timeline.

If the dispute remains unresolved after the response, the escalation path is a **public RFC proposing process changes**. The broker operator commits to engaging with such RFCs in good faith and not blocking them administratively.

---

## 6. Auditability commitments

The broker operator commits to the following, in order of priority:

1. **Publish weight policy at all times.** `GET /info` returns the current `provider_weight_policy` block with all four parameters from §4. Already implemented in the scaffold. This is the highest-priority commitment because the entire weighting system is unverifiable without it.

2. **Publish operator list.** A public read-only endpoint listing all registered providers, their tier, their last-active date, and their cumulative attestation count. Implementation: WS-H part 2. Until then, the operator list is published on the repository wiki and updated when providers are registered or change tier.

3. **Publish audit log.** All `/attest` and `/report` events with provider signatures, queryable by date at `GET /audit/:date`. Implementation: WS-H part 2 (Phase 4 of the roadmap). The audit log is append-only and immutable; corrections (e.g., voided attestations) are written as new audit entries that reference the original.

4. **Publish incident reports.** For any operational anomaly, including:
   - Broker downtime exceeding 1 hour
   - Weight policy emergency change (§4.2)
   - Mass attestation rollback (more than 100 attestations voided in a single action)
   - Security incident (key compromise, unauthorized access, data leak)
   - Federation transition events

   Incident reports are published **within 7 calendar days** of the incident being resolved (or, for ongoing incidents, within 7 days of detection with rolling updates).

5. **Publish quarterly governance reports.** Every calendar quarter, the broker operator publishes a summary including:
   - Providers registered, promoted, demoted, churned
   - Weight policy changes (proposed, accepted, rejected, emergency)
   - Disputes filed, resolved, outstanding
   - Federation discussions and progress
   - Notable trends in attestation volume, cross-op signals, or aggregate scores

   Quarterly reports are due within 30 days of quarter-end.

---

## 7. Open-source commitment

The broker reference implementation is open source under **Apache-2.0**, per the decision recorded in memory `broker_oss_decision_2026_05_13`. The license file lives in the parent repository pending the post-hackathon LICENSE resolution on 2026-05-30; if a different license is chosen for the parent repo, the broker subdirectory retains Apache-2.0 explicitly.

Specific commitments:

- **No private features.** The broker operator commits NOT to ship private features that would advantage them over other potential broker operators in the federation. Any feature added to the production broker is added to the public reference implementation. This commitment extends to operational tooling (admin CLI, monitoring dashboards, alerting rules) where reasonably scopable.

- **No proprietary forks.** The broker operator will not maintain a private fork with capabilities that diverge from the public implementation. If experimentation requires temporary divergence, the experimental branch is published openly with a clear "not yet promoted to main" marker.

- **Mandatory federation on compromise.** If the broker operator becomes commercially compromised — acquisition by a non-neutral party, material conflict of interest, change of control without governance ratification — governance transition to federation is **mandatory** within a published timeline (default 90 days from the triggering event).

The moat for the broker operator is the position and graph (who joined first, who attests to whom, who consumes what), not code. Open source reinforces that the value is in operation, not implementation secrecy.

---

## 8. Conflict of interest

The broker operator (RPC Priority Protocol) may also be a provider — operating a Shield instance and submitting attestations from it. This is the most material conflict of interest in the current single-broker model. The following mitigations apply at all times:

1. **No preferential tier_base.** The broker operator's own provider attestations are weighted **identically** to any other production-tier operator. The `tier_base` is 1.5 for both, with no special multipliers, side-channels, or boosts.

2. **Excluded from median calculation.** The broker operator's own provider weight is **excluded from the `network_median` calculation** used to derive the `cap_multiple_of_active_median` cap. This prevents the broker operator from self-inflating the cap by accumulating weight on its own provider and dragging the median upward.

3. **Daily transparency.** The broker operator publishes their own provider's daily attestation count and dispute count alongside other providers' aggregates in the public operator list (§6, item 2). Anyone auditing the broker can compare the broker operator's own provider behavior against the rest of the network.

4. **No self-resolution of disputes.** If a dispute is filed against the broker operator's own provider, the broker operator commits to either:
   - Recusing and inviting a neutral third party (e.g., another production operator, ecosystem council member) to mediate, OR
   - Publishing a detailed self-investigation with all evidence, and treating any subsequent broker-action dispute (§5.3) as automatically grounds for the neutral mediation path.

5. **Federation acceleration.** A material expansion of the broker operator's own provider business (e.g., doubling Shield instance count, entering a new market) triggers a published review of whether federation timelines should accelerate to maintain the perceived neutrality of the broker.

---

## 9. Transparency on this document

This document is versioned. The current version is shown in the changelog at the bottom of this file and announced in the quarterly governance report.

Material changes to this document — anything that adds, removes, or modifies a commitment — go through the **same 7-day comment window** as weight policy changes (§4.1). Editorial changes (typos, clarifications that do not change meaning) may be made without a comment window but are still logged in the changelog with the marker `(editorial)`.

If you believe a change was incorrectly classified as editorial when it should have been material, file a broker-action dispute (§5.3).

The document is hosted at the root of the public repository so it cannot be quietly altered: every change is in git history and reviewable via PR.

---

## 10. Changelog

- **2026-05-15 v1.0** — Initial governance. Phase 1 single-broker. Federation deferred to v1.1.
