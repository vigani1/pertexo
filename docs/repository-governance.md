# Repository Governance

Updated: 2026-09-01

## Main-branch policy

`main` uses strict required checks, administrator enforcement, linear history,
resolved-conversation enforcement, and blocks force-pushes and deletion. The
production-image build, runtime hardening proof, SBOM, and vulnerability scan
are required alongside quality, unit, coverage, integration, recovery,
compatibility, deployment/security, and CodeQL checks.

Critical paths have explicit owners in `.github/CODEOWNERS`.
Dependency automation follows the grouping, triage, and deferral policy in
[Dependency update operations](./operations/dependency-updates.md).

## Solo-maintainer review exception

GitHub currently reports one repository collaborator: `vigani1`. GitHub does
not allow a pull-request author to satisfy their own required approval. A
one-approval or required-code-owner rule would therefore make every change
unmergeable rather than adding independent review.

The repository intentionally retains zero required approvals while it has one
maintainer. Changes still use protected PR checks, resolved conversations,
incremental reviewable commits, and branch comparison before merge. When a
second maintainer with review permission is added, enable one approval and
required code-owner review before treating independent human review as
enforced.

Verified commits are not currently required because signing is not provisioned
for every local and automation identity. Reconsider this with the same
multi-maintainer transition; never enable it by silently breaking established
automation.
