# ADR 072: New-run recovery from a failed or unknown-outcome step

- **Status:** accepted
- **Date:** 2026-10-13
- **Plan:** [F09](../feature-plans/09-failure-paths-and-recovery.md)

Full replay repeats earlier successful effects. Recovery instead creates a new
run of the source's exact immutable version and original input, copies its
retained completed prefix and executes from its failed invocation onward. The
owner approved the revised F09 plan on 2026-10-13. Recovery never repairs the
original run or reuses its leases, attempt history or provider idempotency keys.

Initially support acyclic root decision trees with sequential actions,
nonconverging Condition branches and leaf Stop run. Earlier completed Conditions
keep their verified recorded choice; unselected paths remain skipped, with no
attempt or side effect. Later Conditions execute normally. Loops, joins,
Parallel, Switch, Wait, child Calls, failure handlers, changed input/version and
artifact reuse are excluded until their reuse rules are reviewed. Retained
publication identity, not the current live publication, decides which executable
runs.

Require existing `run:replay` authority and ordinary workspace/workflow
lifecycle, request idempotency, capacity and admission. Preview and acceptance
use one pure engine planner over typed stored facts. Preview is not a
reservation: acceptance locks source/version and necessary node/attempt rows
against retention, rechecks the facts and atomically creates values, run,
checkpoint, lineage, audit, events and outbox. SQL stores and locks; it does not
implement a second eligibility policy. Within the existing retained 24-hour
idempotency window, exact command retries return known
acceptance before checking expired source data, under current authorization.

A definite failed operation may have partially taken effect. Manual recovery of
a possibly dispatched target therefore requires explicit effects
acknowledgement, bound to the command hash and audit. This exception authorizes
one deliberate new execution; it changes no automatic retry or redelivery
policy. Unknown effects outside the target and incomplete/corrupt evidence still refuse
step recovery. A verified unknown target requires its separate acknowledgement
as recorded in the amendment below. A generic unsafe HTTP 5xx remains unknown under the existing
adapter; receiving an error response is not proof of no remote effect. A
provider's idempotency contract uses a fresh key in the new run and cannot
deduplicate it against the original run. Full replay stays a separate action
with its existing warning rather than a silent fallback.

Copies are bounded inline JSON owned by new node rows, with source provenance
and no fabricated attempt, start time or duration. Reused rows preserve the
node's pinned side-effect class and derive any required nondispatched key for
the new identity. A distinct checkpoint output reference identifies a reused
row; input readers require explicit provenance instead of accepting arbitrary
missing successful attempts. Ordinary stored inline values retain their shape.
Reject artifact descriptors even inside inline JSON. Preserve existing graph,
checkpoint and individual-value bounds; the copied canonical aggregate is
limited to 1 MiB and fetched storage representation to 4 MiB.

Copied details follow the new run's existing retention window. Explicit recovery
can extend that snapshot's availability, but does not pin source node details or
create a retention service. Source history may expire independently; copied
values stay readable until their own expiry. Workspace purge removes the copies.
A recovery counts as a new run; reused steps count as no executed attempts.
Refused recovery offers separately confirmed full replay.

Use ADR 069's one current format and existing three roles. New persisted
recovery state requires matching readers/workers; once accepted, downgrade to
older binaries is unsafe and rollout fixes forward through the current release
boundary. No feature-cohort machinery, new queue, role or service is introduced.


## Owner-approved amendment — 2026-10-14

Allow manual recovery of exactly one selected-path `outcome_unknown` target,
including unsafe HTTP 5xx and post-dispatch network loss. Preserve the existing
adapter classification and attention card. Full replay would repeat earlier
successful effects; this command reuses only the verified completed prefix.

Preview reports `effectRisk: 'unknown_outcome'`. The person must explicitly
acknowledge: “We don't know whether this step reached the service. Retrying can
repeat its effect.” Confirm with “Retry anyway”. The request requires separate
literal-true `acknowledgeUnknownOutcome`; `acknowledgePossibleEffects` cannot
substitute for it. Acceptance checks the freshly planned risk and acknowledgement
under the same source/version/details locks and transaction as admission,
checkpoint, copies, summary, audit, events and outbox. The summary records the
risk and whether its corresponding acknowledgement was supplied. The command
hash binds this acknowledgement; existing commands without it retain their hash.

No automatic retry, reclassification, provider-key reuse or new execution format.
The exact immutable version/input and completed prefix rules remain. Unknown
outcomes elsewhere, multiple targets and incomplete evidence still refuse.
A per-step “safe to repeat” setting is deferred to separately reviewed work.
