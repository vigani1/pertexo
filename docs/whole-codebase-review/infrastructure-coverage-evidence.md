# Infrastructure: coverage evidence and reviewed baselines

Date: 2026-09-12. Four JS files fully read; three JSON files inspected as
producer-bound data, including scope, locators, reasons and representative
branch semantics against already-reviewed source. Thirty tests passed.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `infrastructure/report-risk-coverage.mjs` | WQ-216/WQ-226/WQ-227 | Distinguishes reviewed-uncovered, referenced-only and executed evidence and checks command/run/source/result hash/interval. Named assertion phases are justified. Branch source normalization and malformed hit/report handling weaken confidence. Do not equate reviewed with executed. |
| `infrastructure/report-risk-coverage.test.mjs` | WQ-226/WQ-227 TEST; otherwise KEEP | Tests exact metadata, API overlap identity, stale locations, source change and artifact producer mismatches. Nested execution-evidence tests remain coherent around one owner-scoped temp fixture. Add literal-whitespace/column-bound and malformed report tests; synthetic result objects must not be mistaken for actual integration execution. |
| `infrastructure/generate-coverage-evidence.mjs` | WQ-227 | Source enumeration, static relative-import suite mapping and explicit unmapped category are useful. Declares imports/reexports as their own category, not proof no import side effect exists. Combines present source with independently read artifacts without a producer-to-source freshness check. |
| `infrastructure/generate-coverage-evidence.test.mjs` | KEEP; WQ-227 TEST | Tests categories, exact ownership mapping and src-only traversal with cleanup. Add stale source/artifact/revision and missing-result-hash rejection at producer boundary; no need to execute application imports. |
| `infrastructure/complexity-baseline.json` | DATA; WQ-215 | 30 file ceilings and 33 function ceilings are a historical ratchet, not current clean-code certification. Deleted preview-cleanup entry remains; prune stale identities with reviewed mapping, do not grant a recreated file an obsolete allowance. Preserve meaningful current ceilings rather than bulk raising them. |
| `infrastructure/test-duplication-baseline.json` | DATA/KEEP; WQ-216 | Tool version, separate source/test thresholds, exact fragment hashes and narrow retained family reasons make changes reviewable. Schema, secret envelopes, independent adapters and explicit scenario actions may legitimately repeat. Cross-cutting WQ fixes can invalidate a clone reason; reassess only touched families, never autoapprove all new hashes. |
| `infrastructure/risk-coverage-reviews.json` | DATA; WQ-226/WQ-227 | Schema 4 has 64 source/cohort groups and 357 exact uncovered-branch records, plus three named worker integration references. Broad residual-defensive reasons are limitations, not tests. Preserve generated/unreachable distinctions only where current call paths justify them; actionable source defects in area ledgers supersede blanket reassurance. Fingerprints need semantics-safe extraction and source-linked artifact provenance. |

## WQ-226 — fingerprint exact reviewed source semantics

P2 FIX, pure source probe reproduced. `report-risk-coverage.mjs:normalizedSourceSpan`
uses `.replace(/\s+/gu, ' ')` on raw source including literals. Changing
`if (x === "a b") deny();` to `if (x === "a  b") deny();` produced the same
branch fingerprint even though the accepted string changes. Use exact bounded
source bytes, or token-aware normalization that preserves string/template/regex
contents; exact bytes are simpler and safer unless formatting churn is material.

The same-line span applies start slice then the original endColumn to the
shortened string; use absolute offsets or subtract startColumn for that case.
Test single/multiline spans, nonzero columns, EOF, malformed/zero-coordinate
generated fallback, Unicode and literal whitespace. Same-line branch slice
must exclude unrelated trailing code; semantic literal changes must invalidate
review even when location is unchanged. Regenerate fingerprints only after
reviewing the mapping and preserving existing reasons/evidence distinctions;
do not relabel uncovered decisions as executed. Coordinate with WQ-215 stable
identifiers, but do not build a new source-analysis framework solely for hashes.

## WQ-227 — keep evidence generation honest about source and execution

P2 FIX/TEST. `generate-coverage-evidence.mjs:main` reads current source, old
coverage JSON and risk metadata independently, stamps source files with new
hashes but copies generatedAt from riskReport. Artifact hashes demonstrate which
bytes were read, not that those artifacts were produced by that source. Require
a producer manifest tying cohort result/coverage hashes to candidate fingerprint,
runtime/tool versions and source snapshot; reject changed source or explicitly
emit a stale/unqualified inventory. Capture related input bytes once or verify
unchanged hashes after reading to avoid a mixed snapshot during concurrent runs.

`report-risk-coverage:main` summarizes test health without asserting result
success/completeness; only integration artifact production has the stricter
checks. `summarizeVitestResult` hardcodes retryAttempts/flakyTests=0. State
retry-disabled as verified configuration policy, not inferred observed zero,
unless result schema actually supplies evidence. Validate raw test result shape
and cohort inventory before marking evidence qualified; missing/failed/pending
requirements must be explicit and cohort-specific.

Extend WQ-216 to coverageMetrics/uncoveredBranches/normalizedCoverageByFile:
missing counters currently become zero denominator/100%, metadata without hits
disappears, and nonzero invalid hits can avoid uncovered review. A pure probe
with a statementMap but absent s/f/b returned all 100% on zero totals. Validate
Istanbul correspondence before consuming it and require exact expected source
inventory for each selected cohort, not only lifecycle-command. Current Vitest
producer failure gates remain valuable but do not make malformed evidence valid.

Tests: current source with stale coverage, independently changed artifact,
missing result, malformed hits/branch metadata, dropped selected file, real zero
instrumentation on declaration-only file, failed/pending cohort and retry
configuration drift. Preserve referenced-only integration evidence when no
execution artifact exists. Do not rewrite historical generated snapshots as
current qualification or automatically bless residual branch reasons.
