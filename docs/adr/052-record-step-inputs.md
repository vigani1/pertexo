# ADR 052: Record each step's resolved input

- **Status:** accepted
- **Date:** 2026-09-27
- **Related:** ADR 007 (run and node state), ADR 013 (retention), ADR 050 (run
  data reads)

## Context

ADR 050 lets people read a run's input and every step's output. A step's own
input is still missing: the worker resolves it from the run input, upstream
outputs and the step's input mappings when an attempt starts, hands it to the
executor, and keeps nothing. The run page can only show what the connected
steps returned, not what this step actually received after its mappings ran,
and a failed step, the case people most need to debug, leaves no trace of it
at all.

`app.node_runs.input_ref` was created for this value, is covered by the node
run size bound, the artifact-reference lock and ADR 013's 30-day detail
purge, and has never been written.

## Decision

### When and what

Once the engine has resolved a step attempt's input, and before the executor
runs, the worker records that input on the node run through
`NodeAttemptRunStore.recordInput`. The value is exactly what the executor
receives: the mapped input, the run input for a trigger, or a Merge's settled
input.

A recorded input belongs to the attempt that recorded it, and only the
current attempt's lease can record. Admitting a retry clears its
predecessor's input in the same transaction that makes the retry current, so
a retry that records nothing leaves none, never an earlier attempt's input
passing as its own; the page then shows where the input came from. A resumed
wait receives no new input, so the input its step received stays.

The engine exposes this as an optional `onInputResolved` callback on
`executeNodeAttempt`; engine behaviour without the callback is unchanged.

### Fencing and best effort

`recordInput` writes only while the caller still holds the attempt: same
workspace, run, version, node, invocation, attempt number, running status,
lease owner, fence token and an unexpired lease, the heartbeat's own
predicate. A lost lease records nothing.

Recording is diagnostic. It is stored with the inline execution-value
contract (256 KiB); a larger input, a lost lease, or a database failure
records nothing and the attempt proceeds exactly as before. It never changes
an attempt's outcome, retries or side effects.

### Grant and retention

Migration `0119` grants the worker runtime role `UPDATE (input_ref)` on
`app.node_runs`, next to its existing node-run column grants, and the
coordinator readiness probe requires it alongside them. No new table or
column: the node run's existing retention, bound and artifact lock apply.

### Reading it

`GET /v1/workspaces/:workspaceId/runs/:runId/node-runs/:nodeRunId/input`
returns `{ input }` in ADR 050's shape, `none` when nothing was recorded, under
the same `run:read` authority as the node run's output. Steps that ran before
this change read `none`.

## Consequences

The run page shows what a step received, and still shows where it came from.
Every attempt adds one bounded write before its executor runs. Inputs, like
outputs, may hold whatever data flows through a workflow, and are visible to
the same roles for the same 30 days.

Step logs and provider request details remain out of scope: executors would
have to produce them, and each would need its own bounds and redaction.

## Rejected alternatives

- Returning the input with the attempt's outcome. A failed or timed-out
  attempt never returns one, and those are the inputs people need most.
- Recomputing the input when it's read. Mappings and upstream outputs are
  versioned, but expression evaluation and structured scopes belong to the
  worker; reproducing them in the API would be a second implementation.
- Failing the attempt when the input can't be recorded. A diagnostic must not
  change what a run does.
