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

## 2026-10-15 human-task failures

[ADR 076](076-durable-human-tasks.md) extends the exact failure-value allowlist
with `human_task` classification and `pending_task.expired` /
`pending_task.capacity_exceeded`. These are definite coordinator-owned failures,
separate from provider/executor classifications and automatic retry. Approval may
own a failure link in the existing decision tree, with `approved` / `rejected`
normal branches. It cannot branch inside a sequential handler. Broader join,
loop, timed Wait and Call failure-route exclusions remain unchanged.
