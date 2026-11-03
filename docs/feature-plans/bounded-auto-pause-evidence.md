# Bounded auto-pause evidence

Fix PR #655's unbounded failure ledger while preserving B1 completion ordering.

- Share the supported maximum threshold (100) between settings validation and
  folding. Keep at most the newest 100 eligible failure positions per workflow.
  A success that removes a retained position also supersedes every older,
  discarded position, so late arrival still yields exact evidence below 100.
- Evaluate each bounded batch before compaction to preserve its threshold-crossing
  run. Saturate the internal positioned streak at 100; preserve opaque legacy
  carry, recorded pauses, audits, and success/resume fences.
- Disabled workflows retain the same bounded evidence, so enabling auto-pause
  preserves their streak and applies the setting at the next evaluation.
- Generate a forward migration after 0089 to compact existing ledgers and update
  readiness and upgrade expectations. Do not change existing pause records.
- Verify the review reproduction, unchanged B1 ordering cases, bounded real fold
  reads after 5,000 disabled failures, late-success splits after compaction,
  re-enable evidence, and populated long-ledger upgrades. Run focused package tests
  and the repository's static checks before one push.
