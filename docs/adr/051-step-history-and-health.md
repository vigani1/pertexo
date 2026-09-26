# ADR 051: Step history and health

- **Status:** accepted
- **Date:** 2026-09-27
- **Related:** ADR 044 (run statistics), ADR 050 (run data reads)

## Context

The run page explains one run, and ADR 050 lets it show each step's data.
Someone building or fixing a workflow asks a different question about a
step: how has it been doing? Whether it usually succeeds, how long it takes,
when it last failed and why, and what it returned last time. Today they can
only open runs one by one. The workflow's run statistics (ADR 044) count
whole runs, never steps.

`app.node_runs` already keeps every step run, keyed to its run, for the 30
days ADR 013 keeps run details. No new data is needed to answer those
questions, only bounded reads across a workflow's recent runs.

## Decision

### Scope: the workflow's last 100 runs

Both reads look at the same window: the workflow's newest 100 runs, by
`(created_at desc, id desc)`, still in retention. A fixed count keeps every
read bounded by the existing `(workspace_id, workflow_id, created_at, id)`
index and the node-run `(workspace_id, workflow_run_id, …)` index, whatever
the workflow's volume, and gives each answer a plain meaning: "in the last
100 runs". A run that is still going counts with whatever its steps have
done so far.

### Step health

`GET /v1/workspaces/:workspaceId/workflows/:workflowId/step-health` returns
`{ runsConsidered, oldestRunAt, items }`, one item per step that ran in the
window: its node ID, how many times it ran (a step inside a loop runs once
per item), how many of those succeeded, failed (failed, timed out or outcome
unknown) or were skipped, its latest status and when it ran, and the median
and 95th percentile duration of its successful runs in milliseconds. Steps
that never ran in the window are absent; the client knows the graph.

### One step's recent runs

`GET /v1/workspaces/:workspaceId/workflows/:workflowId/steps/:nodeId/runs?limit=`
returns `{ items }`, that step's runs in the window, newest first, `limit`
1–50 (default 20). Each item names its run (ID, status, creation time and
version) and the step run (ID, status, attempts, start, end and safe error
code), so a client can link to the run page and read the step's output
through ADR 050's output read.

### Authority and failure modes

Both reads need `run:read` and are `authenticated_read`, in a workspace-scoped
read-only transaction under RLS. A workflow outside the workspace is `404`,
as the run reads are; a known workflow with no runs, or a step that never
ran, returns empty results. No migration and no new stored data.

## Consequences

The editor can show a step's recent runs and last result where the step is
built, and workflow settings can rank steps by how often they fail or how
slow they are. Answers describe the last 100 runs, not a time range; a
workflow that runs rarely looks back further, one that runs often looks back
less, and the client says which it is by showing `oldestRunAt`.

## Rejected alternatives

- A time window. Its cost grows with a workflow's volume, and a quiet
  workflow would show nothing.
- Keeping per-step counters as runs finish. That is new stored state to keep
  consistent with retention for numbers a bounded read answers directly.
- Folding step counts into ADR 044's run statistics. Those count runs across
  the workspace; steps belong to one workflow's graph.
