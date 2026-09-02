# Repository governance

`main` is a protected release branch. Normal changes arrive through an
up-to-date pull request after every required CI and CodeQL check succeeds.
Force pushes and branch deletion are disabled, and stale approvals are
dismissed when the reviewed commit changes.

## Required checks

The protected checks are the named jobs emitted by `.github/workflows/ci.yml`
and `.github/workflows/codeql.yml`. A workflow-file change must preserve the
protected context names or update branch protection in the same reviewed
change. A skipped, cancelled, missing, or stale check is not success.

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

`pnpm docs:check` validates repository-local Markdown targets and heading
anchors, keeps the audit implementation SHA synchronized across the audit,
tracker, and current-status documents, and proves that SHA is an ancestor of
the publication commit. It intentionally does not make network-dependent
external-link availability part of deterministic CI.
