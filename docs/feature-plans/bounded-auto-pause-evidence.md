# Bounded auto-pause evidence

Fix PR #655's unbounded failure ledger while preserving B1 completion ordering.

- Share the supported maximum threshold (100) between settings validation and
  folding. Keep at most the newest 100 eligible failure positions per workflow.
  A success that removes a retained position also supersedes every older,
  discarded position, so late arrival still yields exact evidence below 100.
- A pause and its audit record the latest failed triggered run counted in the
  streak and the current streak count, as ADR 056 requires. Retained positions
  cannot identify a historical first crossing. Saturate the internal positioned
  streak at 100; preserve opaque legacy carry, recorded pauses, audits, and
  success/resume fences. The API's `pausedLastRunId` and the screen's
  “Latest failed run” link describe this same evidence.
- Disabled workflows retain the same bounded evidence, so enabling auto-pause
  preserves their streak and applies the setting at the next evaluation.
- Generate a forward migration after 0089 to compact existing ledgers and update
  readiness and upgrade expectations. Do not change existing pause records.
- Verify the review reproduction, unchanged B1 ordering cases, bounded real fold
  reads after 5,000 disabled failures, late-success splits after compaction,
  re-enable evidence, and populated long-ledger upgrades. Run focused package tests
  and the repository's static checks before one push.

The fold also considers the latest committed success beyond its consumption
limit. Under the existing workspace/workflow serialization, an indexed partial
lookup finds the greatest pending success and merges it with the folded success
watermark and consumed batch. This prevents a recovered workflow pausing merely
because its success falls just beyond a batch boundary. Migration 0091 adds the
partial completion-order index. Consumption and its lock order stay unchanged.
Compare limits 10 and 1000 over the same failure/success pattern, and qualify the
real lookup with EXPLAIN over a populated pending queue.
