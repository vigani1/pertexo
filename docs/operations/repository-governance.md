# Repository governance

The policy for `main` and the procedure around it. The collaborator and
protection observations below were recorded on 2026-09-02; they do not by
themselves prove the current GitHub settings, which need the external evidence
described under Verification.

## Main-branch policy

`main` is a protected release branch. Normal changes arrive through a pull
request after the required checks succeed. A pull request doesn't have to be
rebuilt on the newest `main` first, because merges queue up badly otherwise.
Protection uses administrator enforcement, linear history and
resolved-conversation enforcement. Force pushes and branch deletion are disabled,
and stale approvals are dismissed when the reviewed commit changes. `ci-passed`
and CodeQL's `analyze` are required.

Critical paths have explicit owners in `.github/CODEOWNERS`. Dependency
automation follows the grouping, triage and deferral policy in
[Dependency update operations](./dependency-updates.md).

## Required checks

`ci-passed` is the one CI check to require. It waits for every job the change
needs, and fails unless each one succeeded or was skipped on purpose: a docs-only
pull request skips the heavy jobs, and `self-host-drill` runs only for changes to
what it covers. A matrix that was skipped never reports its per-leg names, so
protection can't require those directly. The `faults` job runs on `main` and
nightly, outside `ci-passed`, so no pull request waits for it; a failed run still
blocks releases and deploys, which need the commit's whole run green. A cancelled,
missing or stale `ci-passed` is not success.

## Solo-maintainer review exception

- Owner: repository administrator (`vigani1`)
- Next review: 2026-12-01, or immediately when a second maintainer receives
  review permission or signing is provisioned for every merge identity

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

## Emergency access

There is no standing branch-protection bypass. If GitHub itself or a production
incident makes the normal merge path unusable, a repository administrator may
temporarily change protection only after recording an incident issue with:

1. the incident commander and approving administrator;
2. the exact commit and reason normal checks cannot complete;
3. the intended protection change and maximum 60-minute expiry;
4. local results for every check that can still run; and
5. the rollback owner.

The administrator must restore the exported protection settings immediately
after the emergency commit, attach the before/after GitHub API responses and
audit-log events to the incident, rerun CI and CodeQL on the exact commit, and
open a follow-up pull request for any failed or unavailable check. Emergency
access may not be used to waive a known failing security or data-integrity
check.

## Verification

Release evidence retains the protection API response, the exact required-check
contexts, and a pull request showing that GitHub refused merge while one
required check was failing. Repository-local tests cannot substitute for that
external evidence.
