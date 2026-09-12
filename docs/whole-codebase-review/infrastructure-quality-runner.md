# Infrastructure: quality orchestration and mutation verification

Date: 2026-09-12. All five files fully read by the primary reviewer. Four
mutation-definition/cleanup tests passed; mutation execution itself was not run.
Current-source pure probe accepted a qualification manifest whose cohorts all
failed after setting their self-reported required flags false.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `infrastructure/run-local-quality.mjs` | WQ-223–WQ-225 | Explicit cohorts, isolation run IDs, ownership lock, dynamic ports, report minimums and source identity are useful deep orchestration. Distinct flags for undefined failures preserve truth. Large run function mixes phase dispatch, evidence writing and cleanup; private phase runners may clarify it after correctness/ownership regressions are covered. |
| `infrastructure/run-local-quality.test.mjs` | TEST; WQ-212/WQ-224/WQ-225 | Real nested processes and synthetic output streams test exit/close ordering and cleanup errors. Lock fixture omits directory removal; port test lacks finally if assertion fails. Several child-close waits lack an overall test deadline and register after kill; register before signaling and clean up/reap in finally. Keep each visible lifecycle scenario; no generic flags-heavy fixture. |
| `infrastructure/owned-process-tree.mjs` | KEEP; targeted TEST | Direct child exit before group cleanup before pipe-close is the correct essential ordering; supervisor retains failed ownership for retry and listeners remain through repeated error events. Keep this meaningful shared seam. Add bounded slow-output/backpressure support only with explicit consumer contract, and a failed kill of one group must not prevent attempts on other groups in synchronous last-resort cleanup. |
| `infrastructure/verify-mutation-sensitivity.mjs` | WQ-223/WQ-225 | Exact single mutation site, expected test title plus diagnostic, restored green and copied candidate avoid mutating normal source bytes. Git environment is not isolated; command helper suppresses final termination failure. Seven targeted probes are sensitivity evidence, not repository-wide mutation coverage. |
| `infrastructure/verify-mutation-sensitivity.test.mjs` | KEEP; WQ-223/WQ-225 TEST | Exact sites, owning commands and cleanup aggregation covered. Does not execute red/green, snapshot isolation or command cancellation; add safe fake-command/isolated-repo tests for those boundaries. |

## WQ-223 — isolate explicit snapshot Git commands from hook metadata

P1 FIX when invoked under inherited Git overrides; no unsafe reproduction run.
Normal pre-push runs prepush:check (static/unit/coverage), not the full mutation
cohort. Full quality:local and mutation:check call `verifyMutationSensitivity`, whose
`run` always sets `env: {...process.env, CI:'1'}`. Snapshot git init/config/add/
commit uses only cwd to select the disposable repo. Inherited GIT_DIR,
GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR or injected Git config overrides
can therefore target the calling checkout/index despite that cwd. The existing
`isolatedGitEnvironment` and documentation isolation test already define the
correct project seam.

Use a sanitized Git environment for every explicitly targeted snapshot Git
operation and source-enumeration/identity command, preserving needed PATH and
runtime env without leaking Git overrides to nested tests. In
run-local-quality:sourceIdentity, explicitly target repositoryRoot with isolated
Git environment; otherwise qualification fingerprint may describe a different
Git tree while hashing untracked paths under this checkout. Do not broadly
sanitize unrelated provider configuration or call git config in the user repo.

Add a protected disposable control repo fixture with sentinel HEAD/index/config,
then invoke snapshot setup with inherited Git variables pointing at that control
repo. Assert only newly owned snapshot receives commits/config changes and
control repo remains byte/status-identical. Include GIT_CONFIG_COUNT overrides
and separate index. Test source fingerprint targets expected cwd under overrides.
Do not run integration mutations until this isolation test passes. Keep mutation
changes transient and never amend/rebase/reset caller history.

## WQ-224 — derive qualification requirements from trusted cohort definitions

P2 FIX. `validateQualificationManifest` trusts `cohort.required` and
`cohort.reportExpected` from evidence. A manifest with every known cohort
status='failed', required=false, reportExpected=false passes all cohort checks;
this was reproduced without executing commands. Derive requiredness and report
expectation from LOCAL_QUALITY_COHORTS and qualification mode, require passed
for every required definition, and validate record flags as consistency only.
Reject missing/duplicate/unknown cohorts, false/missing flags, absent reports,
failed overall outcome and malformed evidence shape. Keep explicit AWS-only
exclusions separate from required local cohorts. This is a validator bypass,
not evidence that its normal producer emitted false flags.

Tests construct every downgrade independently and assert rejection. Preserve
partial mode refusal, source stability, exact named exclusion inventory and
report cohort minimums. If later consumers validate persisted evidence, require
real report/source references and fingerprints rather than self-asserted stable
and reportValidated booleans alone; do not relabel existing historical results.

## WQ-225 — close remaining runner acquisition and output-lifecycle gaps

P2 FIX/REFACTOR/TEST with three separately reviewable ownership changes.

1. `acquireRunLock` opens exclusive handle, then writeFile/close outside cleanup;
   setup failure can leak handle/lock. Register owner-local cleanup immediately.
   Release sets released=true before read/token-check/rm succeeds, so a transient
   removal failure cannot be retried by the normal cleanup pass. Mark released
   after successful owner-verified removal; test write, close, read, token-change
   and rm failures with no deletion of another owner's lock. WQ-212 adds fixture
   directory/port cleanup even when assertions fail.
2. `execute` ignores false from stdout/log write, and capture/mutation run append
   all output to unbounded strings. Slow log storage or large failing test output
   can grow memory during otherwise bounded process execution. Add controlled
   writable high-water fixture; pause/resume owned readable streams until both
   required sinks drain, observe sink errors, and retain a bounded diagnostic
   tail or spool file for capture commands. Git diff/source fingerprint cannot
   be silently truncated: stream into hash or fail explicitly on a documented
   bound. Preserve trailing output after exit before close and primary/log error
   aggregation. No broad replacement subprocess framework.
3. Mutation run's final terminateAll('SIGKILL').catch(() => undefined) can hide
   surviving processes; timeout may also return ok if termination coincides with
   a zero exit because timedOut is checked only in catch. Check timeout state on
   success and preserve cleanup failures with original outcome. Test delayed
   zero-exit at timeout and failed termination, retaining supervisor ownership
   for a bounded retry. Add appropriate per-command deadlines for local quality
   capture/cleanup; signal handling is cancellation, not a completion deadline.

After these fixes, private cohort dispatch helpers can replace the large
if/else ladder in run-local-quality while one root owns manifest state, source
stability and final cleanup. Before/after tests must compare cohort order,
report commands, failure/skipped transitions, lock lifetime and exact exclusion
records; splitting files without hiding a meaningful operation is not acceptance.
