# F08 risk-coverage reconciliation

This is a coverage repair, not an F08 runtime decision or phase-completion claim.
Production native admission remains OFF.

## Failure and source identity

PR159 CI run `37390029426`, branch head
`50e6421d006a6e45db9e2ea2e7cd5beb1625a9bc`, passed its percentage gates but failed
the final risk report on `checkpoint-shared.ts:20/0`, line 141. Istanbul's null
end column deliberately makes that review fingerprint the whole source file.
The V3 type-reference change invalidated the old fingerprint even though the
synchronous non-empty-stack guard was unchanged.

The reporter regression reads the real source and manifest and reproduces the
captured metadata shape. It failed with the hosted error before repair; after
repair it also proves that later source drift is still rejected. Fingerprint,
stale-review, exact-inventory, and zero-unreviewed-debt enforcement are unchanged.

## Review reconciliation

Existing reviews are relocated only after matching their old source decisions
against current source and exact uncovered counters; their classifications are
preserved. Executed decisions lose obsolete reviews. Removed engine helpers are
not described as newly covered: control-output validation now belongs to the
already exhaustively instrumented workflow-model package.

The recursive scheduler projection moved from `operations.ts` into
`compilation/executable-scheduler.ts`. That helper is restored to the engine
inventory and original stronger percentage ratchet, with its existing
array-materialization invariant review relocated to the new owner. No numeric
threshold, exclusion, ignore, skip, or timeout is changed.

New reachable gaps have behavior tests instead of review exceptions: native
format/material conflicts, descriptor rejection, independent equal source
ownership, Call output identity, ordinary legacy-join settlement, transaction
budget misuse, pre-input cancellation/recovery rejection, and owned-store
composition and cleanup.

The remaining new reviews name exact upstream invariants: private synchronous
stack ownership; dense array shape/index preservation by bounded JSON
normalization; join-key materialization by checkpoint parsing; and authenticated
frozen Merge configuration. The native normalization exception fallback retains
the same defensive treatment as the existing retained-input boundary. These are
source-bound reviews, not blanket exemptions for new native behavior.

## Local verification

- `node --test infrastructure/coverage/report-risk-coverage.test.mjs`: 32 passed.
- `pnpm --filter @pertexo/workflow-engine test:coverage`: 782 passed; expanded
  scheduler inventory and unchanged numeric gates passed.
- `pnpm --filter @pertexo/database test:coverage`: 1,765 passed.
- `pnpm --filter @pertexo/worker test:coverage`: 1,339 passed in each of its two
  required stages.
- Changed-file lint, relevant package typechecks, formatting, and diff checks
  accompany the repair.

The diagnostic composite report uses new authoritative coverage producers for
the changed test cohorts and the exact downloaded hosted reports for unchanged
cohorts. All 15 required risk inventories pass with 378 reviewed and zero
unreviewed branches. This composite is not a new clean-head CI run or a complete
backend qualification; replacement hosted CI remains required after publishing
the repair.
