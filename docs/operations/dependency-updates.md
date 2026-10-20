# Dependency update operations

The default CODEOWNER owns dependency-update triage. Dependabot proposes every
npm minor and patch update as one weekly pull request, and the container base
images as a second. Each Dependabot pull request runs the complete CI and
rebases whenever the lockfile changes on main, so separate small proposals
crowd out the shared runners. Major versions are upgraded by hand.

## Service levels

- Triage a security update on the same business day. Merge a green fix within
  72 hours or record a time-bounded risk decision in the release evidence.
- Review a green weekly batch within seven calendar days.
- For a failing batch, identify the failing package within two business days.
  Fix it in the batch, or defer that package below so the rest can merge.

## Deferrals

An intentionally deferred version must be recorded in this file before its PR
is closed or ignored. Record the package, current and proposed versions,
compatibility or operational reason, owner, decision date, and a review date no
more than 30 days later. The matching `ignore` entry in
`.github/dependabot.yml` keeps the version out of the weekly batch. Remove both
when upgraded.

| Package          | Current | Proposed | Reason                                                                                                                       | Owner    | Decided    | Review by  |
| ---------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---------- |
| `@xmldom/xmldom` | 0.8.15  | 0.9.12   | 0.9 changes the parser's types and error handling; the SAML response parser needs a deliberate migration with its own tests. | @vigani1 | 2026-10-20 | 2026-11-19 |
