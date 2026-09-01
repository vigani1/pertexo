# Risk-based test confidence

`pnpm test:coverage` measures files selected by four critical-module coverage
configurations and writes `coverage/risk-uncovered-branches.json`. The report's
scope lists those exact files by cohort. It must not be described as coverage of
every security, transaction, recovery, parser, or state-transition surface.

Generated and declarative files are excluded by positive `include` lists, not by
lowering thresholds. Every generated branch entry starts with review status
`unreviewed`; generation performs no risk classification. A reviewer may later
classify a site as testable, unreachable, or deliberately defensive only with
the corresponding test or narrow written justification. The generated report
remains a CI artifact and is not committed because locations change with source
edits.

The workflow transition matrix and workspace role-capability matrix are
mutation canaries: the tests enumerate their complete allowed/denied spaces, so
adding or removing an authorization capability or state transition without a
corresponding reviewed policy change fails the suite. Percentage thresholds are
ratchets rather than targets and may only move upward after meaningful tests or
new risk-bearing source enters a measured cohort.
