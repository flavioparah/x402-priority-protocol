# Contributing to x402-shield / RPC Priority Protocol

Thanks for the interest. This document explains how to contribute productively.

## What this project is

This repository contains:

1. **`x402-shield`** — a reference implementation of the RPC Priority protocol (Node.js + Express).
2. **RFCs** in [`docs/rfc/`](./docs/rfc/) — the normative protocol specifications (`x402-priority`, `x402-trust-score`, `x402-qos-cooperative`).
3. A reference broker (under extraction — see [`docs/superpowers/specs/2026-05-12-trust-score-cross-op-roadmap.md`](./docs/superpowers/specs/2026-05-12-trust-score-cross-op-roadmap.md)).

The code in this repo is reference-quality. We aim for it to be production-deployable, but the **specs in `docs/rfc/` are the source of truth** — operators implementing the protocol independently should follow the RFCs, not the code.

## How to contribute

### Bugs and small fixes

1. **Open an issue first** if the fix is non-trivial. This lets us validate the diagnosis before you spend time on a patch.
2. For typos, broken links, doc fixes — a direct PR is fine.

### Features and protocol changes

1. **Protocol changes** require an RFC update first. See [`docs/rfc/README.md`](./docs/rfc/README.md). PRs that change code without a corresponding spec change are unlikely to land.
2. **Reference implementation changes** that don't touch the protocol — open an issue describing the change before coding.
3. Once we agree on direction, send a PR against `main`.

### RFC comments

RFCs are open for public comment until the date noted in the RFC header. Comment via GitHub issues with the label `rfc:<spec-name>` (e.g., `rfc:trust-score`).

## Development setup

```bash
# Clone
git clone https://github.com/flavioparah/x402-priority-protocol.git
cd x402-priority-protocol
npm install

# Copy env template
cp .env.example .env
# Edit .env — set SOLANA_RPC_URL, OPERATOR_WALLET, etc.

# Run locally (requires Redis on localhost:6379)
npm start

# Run tests
npm test
```

See [`docs/DEPLOY.md`](./docs/DEPLOY.md) for production deployment.

## PR checklist

- [ ] Tests pass locally (`npm test`)
- [ ] If you changed a public endpoint or response shape, the corresponding RFC has been updated (or a separate RFC PR is linked)
- [ ] If you added a new dependency, justify it in the PR description
- [ ] No secrets, private keys, or sensitive operator data committed
- [ ] No internal-only documents committed (pitch, outreach drafts, patent disclosures — all gitignored under `docs/context/`, `docs/pitch/`, etc.)
- [ ] Commit message follows [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat(broker):`, `fix(shield):`, `docs(rfc):`)

## Code style

- **JavaScript**: Node 18+ syntax. No transpilation. Prefer plain `require()` over ESM (matches existing codebase).
- **Comments**: explain *why*, not *what*. Avoid restating the code in English.
- **Line length**: ~100 chars soft limit, not enforced.
- **Testing**: aim for ≥70% coverage on new code; integration tests preferred over heavy mocking.

## Patent and IP

By contributing, you confirm that:
- Your contribution is your own work, and you have the right to license it under the project's license (see [LICENSE](./LICENSE)).
- You are not contributing any patented technology you don't own or hold a license to.
- You understand and accept the project's [Patent Pledge](./docs/PATENT-PLEDGE.md), which governs how the project handles patent claims.

If you work for a company that may have rights to your contribution, please get clearance before submitting.

## Code of Conduct

Be respectful. Disagreements about technical direction are welcome; personal attacks are not. We follow the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/) — if you want a more formal version, ask via issue and we'll adopt one.

## License

See [LICENSE](./LICENSE) for the project license. Contributions are accepted under the same license unless explicitly noted otherwise in the PR.

## Questions

Open an issue with the label `question`, or email `dev@rpcpriority.com` (when established).
