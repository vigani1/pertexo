# F08 native step result fence

Status: defensive source implementation in the unregistered 0137 candidate.
Native writers, catalogs and execution remain OFF; installation is not authorized
and protected SQL qualification remains PAUSED. This addresses the candidate's
logical NULL/state/pointer projection gap recorded in [F08](08-subworkflows.md),
not F08 completion or installed/runtime qualification.

## The gap

F08 records that "an owned fresh transaction still committed a logical NULL
clear" and that NULL, state and current-pointer transitions needed the
coordinator authority fence. The candidate guarded a run's result
(`workflow_runs.output_ref`) and a Call step's input, but nothing guarded a
native step's own logical projection on `app.node_runs`, while migration 0007
grants the worker role `UPDATE` on its `status`, `output_ref`,
`current_attempt_id` and `current_attempt_number`. Against the candidate, a
fresh worker-role transaction committed all of these on a finished native step:

- clearing its accepted result to NULL;
- replacing it with a forged value;
- failing or reopening it;
- moving its current-attempt pointer.

## The fence

One deferred constraint trigger, `native_node_logical_projection_owned`, checks
the step's committed row:

1. A new or changed result on a native step must be an accepted value of that
   step: its current attempt's owned output (or a Call declaration's owned
   input alias), or its admitted, sealed child's owned run result
   (`app.native_node_accepted_output`). A new or changed nonnull result also
   requires that source to be unrevoked and unexpired at the SQL clock. The
   historical lookup deliberately remains unfiltered so retention can still
   recognize a revoked OLD value and clear it legitimately.
2. Leaving an accepted result (clearing it, changing the status, or moving the
   attempt pointer) needs the established coordinator authority: the same
   transaction completed a `workflow-coordinator` receipt for an
   `advance-workflow-run` delivery of this run and advanced this run's
   checkpoint. Both are server-side facts (`xmin` of the current top-level
   transaction; the coordinator claims, CASes and completes in one transaction
   without savepoints). No caller flag or setting is trusted.
3. Retention may clear the result, leaving status and pointer unchanged, only
   after its accepted value is revoked, as for the run result and Call input.

Steps of non-native runs, and native steps that have not yet accepted a result,
keep their existing behaviour.

The commit check reads coordinator receipts as the owner, so the candidate adds
`inbox_receipts_native_coordinator_owner_select` (owner `SELECT` of the scoped
workspace's `workflow-coordinator` receipts only). Without it the owner could
not see those receipts at all; the candidate's existing
`check_native_terminal_result_commit` needs the same visibility.

## Source evidence and historical report

Claude reported 14 passing worker-role scenarios for original commit
`ead7d27b`, with ten protection scenarios failing when its trigger was disabled.
That report belongs to the original source, not the repaired merged candidate:
review found that its new-result branch accepted revoked or expired but retained
values on NULL-to-nonnull restoration. The merged source adds the current
eligibility check above. No campaign was run or retried for this repair, and no
original campaign result qualifies the repaired candidate.

The separately owned campaign file is preserved unchanged. The following table
records its reported original scenario coverage, not verified outcomes for the
repaired candidate.

| Scenario | Result |
| --- | --- |
| Fresh transaction clears, forges, fails or reopens a finished result, or moves its pointer | Refused at commit; row unchanged |
| A rolled-back change | Result and receipts exactly as before |
| Re-delivering the same accepted result | Allowed, no change |
| The coordinator's own claim, change, checkpoint CAS and completion | Allowed |
| Coordinator proof for another run, a receipt without a CAS, a CAS without a completed receipt | Refused |
| The coordinator setting a value that is not accepted | Refused |
| Retention clearing a revoked result; restoring a value afterwards | Allowed; refused |
| An unfinished native step finishing with a forged or its accepted value | Refused; allowed |
| A non-native step | Unchanged behaviour |

## Limits

- The coordinator and the attempt worker share one database role. The fence
  stops stray, buggy and single-row writes, but a worker-role transaction that
  reproduces the coordinator's whole delivery transaction still passes. Telling
  them apart needs separate database roles, a separate decision.
- A Call step's declaration-phase result (the input alias before the child
  finishes) is transient and is not fenced; its input stays guarded.
- The reported scenarios seed rows directly and do not qualify the native
  runtime, which cannot run end to end yet. The excluded campaign remains
  REQUIRED / UNCLOSED / EXCLUDED; no alternate executor or installation is
  authorized by this source merge.
- Complete function ACL, role/membership ACL cohort, constraints/policies/indexes/
  triggers, full emitted process/dependency manifest, and creator/storage-origin/
  private-network/transport qualification all remain open.
