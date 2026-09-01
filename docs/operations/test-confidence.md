# Risk-based test confidence

`pnpm test:coverage` measures four intentionally selected high-risk cohorts and
writes `coverage/risk-uncovered-branches.json`. The report lists every uncovered
branch location in the security, transaction, recovery, parser, and
state-transition surfaces selected by the package coverage configurations.

Generated and declarative files are excluded by positive `include` lists, not by
lowering thresholds. A branch present in the report is classified `testable`;
unreachable or deliberately defensive branches must instead receive a narrow
coverage-ignore comment with an adjacent reason during review. The generated
report remains a CI artifact and is not committed because locations change with
source edits.

The workflow transition matrix and workspace role-capability matrix are
mutation canaries: the tests enumerate their complete allowed/denied spaces, so
adding or removing an authorization capability or state transition without a
corresponding reviewed policy change fails the suite. Percentage thresholds are
ratchets rather than targets and may only move upward after meaningful tests or
new risk-bearing source enters a measured cohort.
