# ADR 073: Explicit failure paths in the current run

- **Status:** accepted
- **Date:** 2026-10-14
- **Plan:** [F09](../feature-plans/09-failure-paths-and-recovery.md)

A workflow can follow an authored alternative path after an eligible definite
failure exhausts the existing retry policy. The owner approved this bounded
scope on 2026-10-13. An existing link with source port `__failure` opts in;
the link owns the destination. Configuration does not duplicate that choice.
Authoring and compilation use one shared model rule, including reserved-port
collisions. Ordinary publications retain their existing identity and rules.

Initially support an acyclic root decision tree with sequential actions,
nonconverging Condition choices and leaf Stop run. Each ordinary action may
have one disjoint sequential handler, optionally ending in Stop run. A handler
has one owner, cannot be disabled, cannot own another handler and cannot join
the normal path. Trigger, Condition and Stop run cannot source a failure link.
Switch, Parallel, Merge, For Each, Wait and Call workflow are excluded. Existing
graph, invocation, executable and checkpoint limits remain authoritative.

Only a final definite executor failure can select a handler. Initially admit
the worker's fixed `execution.authentication`, `execution.network`,
`execution.provider`, `execution.rate_limit` and `execution.timeout` codes,
matched to their corresponding executor classification. Configuration/internal
errors, platform bounds, corrupt state, cancellation, persisted timeouts and
unknown outcomes remain unhandled. A retry in backoff selects neither path.
The provider's existing dispatch/outcome classification remains authoritative;
unsafe HTTP 5xx or ambiguous post-dispatch failure stays unknown.

Route selection keeps the source failed, skips its unexecuted normal suffix and
admits the handler in the source's existing Condition scope and run slot.
Handler identity is deterministic in that run/version. Pending handling prevents
premature settlement; only successful completion of its sink records handled.
A failed handler fails the run. A selected route that never finishes
successfully remains unhandled, including a stopped or unknown run. Preserve
precedence: unknown effects, cancellation, deadline, unhandled failure, success.
Callable result validation can still fail the run after a handler succeeds;
handling does not invent a missing business result.

One `node_failure` mapping alternative exposes only the selected entry's source
`nodeId`, `invocationKey`, `attemptNumber`, `errorKind` and `safeErrorCode`.
Later handler steps use ordinary outputs. Failure data is separate from
successful output and cannot become a global expression namespace. The source's
bounded inline `failure_ref` is mandatory execution data bound to the exact
source invocation, handler entry and current handler lease; it contains no
provider message, stack, body, header, credentials or diagnostic input.

The pure engine decides selection and disposition. Storage commits the envelope,
compact checkpoint/sink identity, source-row handling metadata, sequenced route
events, admissions and outbox with the existing checkpoint CAS. Redelivery or
restart observes that selection rather than creating another logical handler.
Keep a retained `handledFailureCount` on run summaries. Details retire normally;
missing evidence cannot imply a successful handler. Final run outcome owns
alerts, inbox and trigger pause, while failed-step health remains truthful.

ADR 069's current format and three roles apply. Matching readers/workers must
ship with the migration; accepted routed state makes older binaries unsafe to
restore. Recovery initially refuses graphs with failure links (ADR 072).
Compensation, return-to-main joins, loops, child handling and artifact recovery
need separately reviewed semantics rather than implicit fallback behavior.


## Follow-up: error workflows (2026-10-15)

The owner authorized a separate workflow-level follow-up in F09. A current
operational setting selects another published workflow with the **When a
workflow fails** trigger. Changing it requires edit access to both workflows;
it grants neither workflow nor credential access. Final failed, timed-out and
unknown runs capture the current target version into a unique source-run
intent in the terminal transaction. Handled success and cancellation do not.

The target is admitted separately through normal capacity/lifecycle checks;
refusal never prevents recording the source failure. Its input is a strict
allowlist of workflow/version identity and name, relative run link, failed step
identity and fixed sanitized error code/description. No execution values or
provider error strings cross this interface. Redelivery uses the same intent
and admission receipt. Error-origin runs, their Calls and deliberate replays or
recoveries preserve a suppression flag, preventing direct and indirect loops.

The existing queues, app role, forced workspace security, immutable publications
and retention/purge own this behavior. Capture uses the setting at failure,
rather than pinning a possibly old handler for every successful source run.
The intent retains the captured publication with its source history. Workers
and readers must understand the additive trigger kind and origin flag before
publishing error-trigger workflows. Existing in-run routes, unknown-outcome
warnings, automatic retries and recovery restrictions are unchanged.

## 2026-10-15 error-workflow summary and capacity wait

The captured failure summary also includes immutable step name/type and F09's
exact allowlisted failure kind/code. Missing classifications remain null, with
the existing fixed generic error. It never copies provider text or execution
values. Older summaries retain their original meaning with empty added metadata.

Queue pressure keeps the intent pending for a fixed 15 minutes from its first
capacity refusal, with 30-second existing-outbox retries and a durable deadline.
Replacement deliveries, the current intent identity and completed transport
receipts commit together. Duplicate old deliveries cannot admit another run or
reset the deadline. Expiry records the existing visible queue-full refusal.
Admission still uses the captured publication and one semantic source-run
identity. Other current authority/lifecycle refusals and recursion suppression
stay unchanged. No extra queue, scanner, service or role is introduced.

## 2026-10-15 human-task failures

[ADR 076](076-durable-human-tasks.md) extends the exact failure-value allowlist
with `human_task` classification and `pending_task.expired` /
`pending_task.capacity_exceeded`. These are definite coordinator-owned failures,
separate from provider/executor classifications and automatic retry. Approval may
own a failure link in the existing decision tree, with `approved` / `rejected`
normal branches. It cannot branch inside a sequential handler. Broader join,
loop, timed Wait and Call failure-route exclusions remain unchanged.

### Amendment: missing publications and capacity wakeups (2026-10-16)

If the selected error workflow has no current publication when the source fails,
record a refused intent with `target_not_published` on that source run. Its target
version and outbox ID are null; pending and accepted intents still require both.
Do not enqueue a job without an immutable version or silently lose this refusal.

Replace the 30-second retry schedule with promotion of the existing pending
outbox delivery when a queued run starts or settles. The first queue refusal
still fixes a database-time deadline 15 minutes later. Schedule the replacement
at that deadline as the restart-safe fallback; reaching it records visible
`queue_full`, even if capacity has since become available. A release promotes up
to 100 same-workspace pending deliveries, oldest first, without changing their
payload, checksum or receipt identity. Each later queue refusal retains the
original deadline. There is no new queue, scanner or service.

Hold the existing execution-counter lock outside the admission savepoint through
commit. Check the persisted deadline against fresh database time after acquiring
that fence, so waiting for it cannot admit an expired intent. A concurrent release
then either precedes the capacity check or sees its committed deferred delivery. This prevents lost wakeups. Migration 0018 grants
only scheduling-column updates to the existing app role, under an additional
same-workspace, unpublished/unfailed `start-error-workflow` update policy.
Payloads, other job kinds and other workspaces remain fenced.

The shared trigger tuple also owns browser recognition, including version checks:
`shape.ts` and `nodeUsesRunInputDirectly` use `isWorkflowTriggerDefinition`. The
workflow-list label/icon map is presentation only, not another membership list.
Matching run-summary readers must precede writers of unpublished-target refusals.

## Step failures amendment — 2026-10-19

A failure link also takes the step's own definite failures. Besides the five
provider classifications, the routable codes are:

- invalid input or setup (`execution.attempt_invalid`,
  `execution.variable_missing`, `execution.configuration`);
- an expression that failed, went over its limits or ran out of time
  (`execution.expression_failed`, `execution.expression_limit_exceeded`,
  `execution.expression_timed_out`);
- a file the step can't read (`execution.file_input`);
- a table refusal (`execution.table_*` for not found, invalid values, quota,
  conflict, key conflict, result too large, unsafe filter);
- a utility's fixed data/setup refusal (invalid text fields, XML data/name/root/DTD,
  HTML selectors, crypto input or Signing key setup), or Create file's invalid
  data/column setup (`utility.*` and `file.create_data` / `file.create_columns`,
  individually allowlisted, corrected in the 2026-10-23 audit follow-up);
- an error in the step's code (`code.syntax_error`, `code.runtime_error`,
  `code.timeout`, `code.memory_limit`, `code.output_invalid`,
  `code.module_refused`).

Each kind still matches only its writer's fixed codes. Cancellation, unknown
outcomes, run deadlines, retries in backoff, `code.disabled`,
`code.runner_unavailable` and table lease expiry stay unhandled. The worker
records invalid input as an executor failure of kind `configuration`, so the
coordinator decides it on the same path as every other step failure, and error
workflows classify these failures too. The change follows n8n's error output and
Zapier's error paths, which catch any step error, and was approved with the
[step capability upgrades](../feature-plans/step-capability-upgrades.md).

### Audit correction — 2026-10-23

Utility and Create file data/setup writers now match the definite-failure rule
above. Their existing bounded private diagnostics may be persisted for the
fixed writer codes; that does not expose them in a failure mapping or error
workflow. Storage faults, utility resource/collection bounds and
`file.create_size` remain unhandled. Discovered CSV-column overflow uses that
existing size code; invalid column names and missing columns remain setup
failures. Neither code prefixes nor arbitrary provider text grant routing.
