# Dependency update operations

The default CODEOWNER owns dependency-update triage. Dependabot groups
production packages by compatibility boundary so a failing HTTP framework,
schema validator, AWS client, telemetry library, or queue client can be reviewed
without disabling unrelated updates. Small runtime utilities remain grouped;
unmatched production dependencies open independently.

## Service levels

- Triage a security update on the same business day. Merge a green fix within
  72 hours or record a time-bounded risk decision in the release evidence.
- Review a green routine minor/patch update within seven calendar days.
- For a failing update, identify the failing package boundary within two
  business days. Rebase or split the proposal; do not close automation merely
  because a broad group obscures the cause.
- Development-only updates may remain grouped while their complete required
  check set is green.

## Deferrals

An intentionally deferred version must be recorded in this file before its PR
is closed or ignored. Record the package, current and proposed versions,
compatibility or operational reason, owner, decision date, and a review date no
more than 30 days later. Remove the entry when upgraded.

There are no intentional dependency deferrals as of 2026-09-01.
