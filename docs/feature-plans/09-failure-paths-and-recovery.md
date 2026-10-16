# F09 — Failure paths, recovery and error workflows

Status: baseline delivered; requested follow-ups implemented; release is gated on PR CI.
Updated: 2026-10-16. [Roadmap](../product-roadmap.md).
Decisions: [ADR 072](../adr/072-failed-step-recovery.md) and
[ADR 073](../adr/073-workflow-failure-routing.md). History stays in git and PRs.

## Decisions

Recovery creates a new run of the source's exact immutable version and input. It
reuses successful selected-prefix values and recorded choices, then executes the
failed step onward. Full replay remains a separate action. The owner's dated
unknown-outcome decision requires a stronger acknowledgement; it does not change
automatic retry classification.

Failure links select a disjoint handler after an eligible definite failure has
exhausted automatic retries. A handled source remains failed in history; a fully
successful handler can let the run succeed. Error workflows are a separate,
independent run after final run failure, rather than another in-run handler.

## Rules

### Recovery

- One acyclic root decision tree: sequential actions, nonconverging Conditions
  and leaf Stop run. No fan-out, joins, Switch, Parallel, For each, Wait, Call,
  human tasks or failure links. Unsupported graphs retain full replay.
- Require current `run:replay` authority, a terminal failed/unknown source, one
  verified target, complete successful selected prefix and no later executed
  effect. Unknown effects outside the target or missing evidence refuse recovery.
- Verify earlier Condition selections against immutable output and scope. Reuse
  those choices; derive off-path skips through the normal scheduler. Conditions
  after the target execute freshly. Do not infer choices from missing rows.
- Safe targets and affirmative no-dispatch evidence use ordinary confirmation.
  Definite possible-effects targets require `acknowledgePossibleEffects`.
  Verified unknown targets require separate `acknowledgeUnknownOutcome`:
  “We don't know whether this step reached the service. Retrying can repeat its
  effect.” Both effects cases confirm with **Retry anyway**. Check and record the
  exact acknowledgement server-side in the acceptance transaction and summary.
- Unsafe HTTP 5xx and ambiguous post-dispatch loss remain unknown; they are never
  automatically retried as safe failures. Unknown attention remains unchanged.
- Retained input/prefix values must be inline and free of nested artifact
  references. Bound canonical reuse to 1 MiB, fetched serialized values to 4 MiB,
  and the new checkpoint to existing 256 KiB/invocation limits. No file download
  or special Read file exception. Refuse missing/expired/corrupt values clearly.
- Build a fresh checkpoint and new node rows with explicit reused provenance;
  never fabricate attempts, elapsed time, leases or provider calls. New suffix
  effects use new-run provider identities. History emits `node.reused`.
- Lock source/version/value facts in stable order and recheck preview eligibility
  at acceptance. Admission, capacity, copied values, checkpoint, audit, summary
  and outbox commit atomically. Exact accepted-command retries precede retention
  checks under current authority. Copied values follow the new run's retention.
- Variables inherit the source's immutable set reference under F13; current
  credentials are resolved normally. Never copy credentials or source dispatch
  bindings. A preview is informative, not a reservation.

### Failure links

- `__failure` is one engine-owned source port. Shared workflow-model rules own
  source eligibility and topology; all trigger checks use `graph/triggers.ts`.
- Routed root graphs are disjoint decision trees. Condition and Approval may
  branch through their declared normal ports; handlers are sequential chains,
  optionally ending at Stop run. No convergence, nested handler, disabled
  handler, loop-body route or excluded concurrent/durable control.
- Eligible sources exclude triggers, Condition, Stop run and the excluded
  controls. Human-task expiry/capacity use their explicit safe classifications.
  Only final allowlisted definite failures route; cancellation, run deadline,
  unknown outcome, corrupt state and platform bounds do not.
- One selected handler owns the source's safe `node_failure` mapping. Its fields
  are node/invocation/attempt identity and allowlisted error kind/code. No provider
  text, stack, credentials, run input/output or nonexistent successful output.
- Route identity, bounded failure value, pending/handled disposition, checkpoint,
  events and admission commit together. Retries/restart cannot select a second
  handler. A failed handler fails the run; partial handling is not success.
- Final run outcome owns failure alerts, Inbox, auto-pause and statistics.
  Handled success emits no final failure notice. Connection health remains
  independent. Preserve terminal precedence and ordinary cancellation rules.

### Error workflows

- Settings may name a different active same-workspace workflow with one published
  **When a workflow fails** trigger. Setting/changing requires edit access to
  both workflows; clearing requires source edit access.
- Policy is operational metadata, outside graph/export/checksum. Final `failed`,
  `timed_out` or `outcome_unknown` captures one intent, exact target publication
  and safe summary per source run. An unpublished target instead records visible
  `target_not_published`, with no version or outbox job. Handled success and
  cancellation create none.
- Summary contains workflow/version/run identity and relative run link, terminal
  status, failed step identity/name/node type, and allowlisted safe error
  kind/code plus fixed description. Missing legacy step facts remain null.
  Never read/copy run data, provider messages, credentials or diagnostics.
- Error-origin runs never start error workflows. Calls and replay/recovery retain
  that origin, preventing indirect chains while preserving normal notices.
- The existing outbox/transport receipt owns once-only admission. First queue
  saturation starts a fixed database-time 15-minute window; keep intent pending
  and schedule the existing outbox at its deadline. A queued run starting or
  settling wakes up to 100 pending deliveries immediately, oldest first. Hold
  the existing counter fence through admission/deferral commit to prevent lost
  releases. Check expiry against database time after acquiring that fence. Free
  capacity starts exactly one captured-version run; expiry records
  visible `queue_full`, without extending the deadline. Lifecycle
  refusals remain current and visible. No extra queue/scanner/service.
- Error workflows are independent admissions and capture current workspace
  variables, never source-run data. Normal queue/capacity/credential rules apply.

## Slices and status

| Slice | Status |
| --- | --- |
| Measured dispatcher latency and existing recovery clarity | Complete |
| Recovery planner, atomic acceptance, reused history and UI | Complete |
| Failure-route runtime, authoring and handled history | Complete |
| Explicit unknown-target acknowledgement | Complete |
| Error workflows, safe step facts and bounded queue waiting | Complete |
| Shared trigger definition, including web recognition/icons | Implemented; PR CI gates release |

Qualification covers real HTTP 5xx/network loss, missing acknowledgements,
Conditions, restart/redelivery, provider-effect counts, expired values, handler
outcomes, queue full/free/expired races and sanitized summaries. Required local
checks, mocked browser tests and real API/worker/browser/SQL evidence precede
green CI and rebase merge. The per-step dispatch baseline was measured before
engine changes; avoid restoring polling delay between ready steps.

## Follow-up decisions (2026-10-16)

- Web shape and direct-run-input recognition use the shared versioned
  `isWorkflowTriggerDefinition`; the canonical tuple also supplies ordering.
  Web labels/icons cover Form and When a workflow fails, without another list.
  The earlier “shared trigger definition complete” status omitted these consumers.
- Missing publications create a safe recorded refusal, not a silent return.
  Migration 0018 permits null target version/outbox only for that refusal.
- Capacity release promotes the existing outbox; a deadline delivery preserves
  refusal after 15 minutes across restart. The existing app role gets only
  scheduling-column updates for same-workspace pending error jobs. No new role.

Qualification: trigger icons/version checks; unpublished target readback; ordinary
coordinator release, duplicate/replacement races, expiry with newly free capacity,
expiry during a counter-lock wait, and workspace/job/payload fences. Local qualification is complete; the pull request records CI and merge receipts.
Human-task authoring and forms are tracked in [F10](10-human-approvals.md) and
[F11](11-forms-and-resume-input.md).

## Later work

Recovery/routing for loops, joins, child Calls and richer durable controls needs
explicit scope/provenance rules. Artifact-aware recovery, changed-version prefix
reuse, provider reconciliation and an explicit per-step safe-to-repeat setting
remain deferred. No cross-run exactly-once guarantee or speculative subsystem.
See the [error workflow guide](../guides/error-workflows.md).
