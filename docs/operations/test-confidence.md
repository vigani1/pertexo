# Risk-based test confidence

`pnpm test:coverage` runs the coverage configurations selected by the
[root package script](../../package.json) and writes
`coverage/risk-uncovered-branches.json`. The report's
scope lists those exact files, coverable-line denominator, percentages, and
test-health record by cohort. It must not be described as coverage of every
security, transaction, recovery, parser, or state-transition surface.

Generated and declarative files are excluded by positive `include` lists, not by
lowering thresholds. Every generated branch entry starts with review status
`unreviewed`; generation performs no risk classification. A reviewer may later
classify an exact site as unreachable, compiler-generated, deliberately
defensive, or covered by a named integration cohort only with a narrow written
justification. Testable unit paths are exercised instead of classified. The
generated report remains a CI artifact and is not committed because locations
change with source edits. Exact reviews live in the committed manifest, and
missing, duplicate, malformed, or stale identities fail the report.

The workflow transition matrix, retry decision table, workspace
role-capability matrix, and provider dispatch-fence tests are mutation canaries.
They enumerate allowed/denied or safe/unsafe decision spaces, so inverting a
high-consequence authorization, transition, retry, or fence decision fails the
suite. Percentage thresholds are ratchets rather than targets and may only move
upward after meaningful tests or new risk-bearing source enters a measured
cohort.

Each coverage command also writes a Vitest JSON result beside its coverage
files. The combined report records elapsed duration, passed, failed, skipped,
and todo tests per cohort. Retries are deliberately disabled, so retry attempts
and retry-masked flakes are both structurally zero; a failed test cannot become
green through an automatic rerun. CI uploads the per-run JSON with the coverage
artifact, making duration and health comparable across retained workflow runs.

Real-service integration, compatibility, recovery, provider, load, and
deployed-drill evidence remains in separate commands and artifacts. The risk
coverage report may link an uncovered unit-instrumentation branch to a named
integration test, but it never counts that external cohort as unit execution.
