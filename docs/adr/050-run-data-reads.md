# ADR 050: Run data reads

- **Status:** accepted
- **Date:** 2026-09-26
- **Related:** ADR 007 (run and node state), ADR 013 (retention), ADR 016
  (node preview and testing), ADR 031 (authenticated run replay)

## Context

Every run keeps the input it started with (`app.workflow_runs.input_ref`), and
every finished node run keeps its output (`app.node_runs.output_ref`), each as a
bounded stored execution value: inline JSON up to 256 KiB or an artifact
reference. ADR 013 clears a run's input 30 days after it was created, and
removes its node runs, attempts and events 30 days after it completed.

No public read returns these values. The run page can say that a step
succeeded and when, but not what came in or what it produced, and a replay asks
people to type the input again because the page cannot show the one the run
used. What a run did with its data is the first thing people need when a
workflow misbehaves.

Node runs keep no input of their own: `app.node_runs.input_ref` is written by
no execution path, and the executor builds a step's input from the run input
and upstream outputs when an attempt starts. Showing an exact per-step input
would mean storing new data, which is out of scope here.

## Decision

### Two reads

- `GET /v1/workspaces/:workspaceId/runs/:runId/input` returns `{ input }`.
- `GET /v1/workspaces/:workspaceId/runs/:runId/node-runs/:nodeRunId/output`
  returns `{ output }` for the node run's current output.

Both values use one shape:

| `kind`     | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `inline`   | `value` is the stored JSON, exactly as persisted                          |
| `artifact` | `artifactId` names the file; the artifact API serves its bytes            |
| `none`     | Nothing is stored: a run started without input, or a step with no output |
| `expired`  | A run's input is past its 30-day window and no longer kept               |

Stored input and output that retention has cleared are indistinguishable from
values never provided. The input read therefore returns `expired` for a run
without input once `created_at` is 30 days old, and `none` before that; a run
past the window that never had input also reads `expired`, which is still true
in effect. A node run whose run details were purged no longer exists and reads
`404`, like any unknown node run.

The routes are `GET`, rate-limited as `authenticated_read`, and read in a
workspace-scoped read-only transaction under RLS. An unknown run, or a node run
that does not belong to that run and workspace, is `404` without revealing
which. Values are returned exactly as stored; the reads never evaluate,
redact, or reshape them.

### Authority

Both reads require `run:read`, the capability that already opens the run, its
events and its artifact outputs (`artifact:read` is held by every role that
holds `run:read`). Hiding inline values from a role that can already download
the same run's files would add a capability without protecting anything, so
data follows the run. Connection credentials are resolved only inside the
worker and never enter stored execution values (ADR 016), so no secret
material becomes readable. Reads are not audited, matching run and preview
reads.

### Run summaries

The run read summary adds `replaySourceRunId` (nullable), so a replay can link
back to the run it came from. Run list items add `failedStep`, the most
recently completed node run of a failed, timed-out or outcome-unknown run
that ended that way, with its node ID, its label and definition key from the
run's workflow version, and its safe error code; `null` when no step
explains the outcome. The list computes it with one extra bounded query for
the page's unsuccessful runs only.

## Consequences

The run page can show data in and data out for each step, the run's input,
and a replay that starts from the original input, and the runs list can say
where a run failed. The API returns up to 256 KiB per value, bounded by the
existing execution-value contract, and the browser fetches one value at a time,
only when someone opens that step.

"Data in" for a step is the output of the steps that ran before it, not an
exact record of the step's resolved input after mappings. Recording exact
inputs, step logs or provider request details is new stored data and needs its
own decision.

## Rejected alternatives

- A separate capability for run data. Every role that can read runs can
  already download their files.
- Returning all values inside the run snapshot. A run can have 1,000 node
  runs, and most people open one or two steps.
- Redacting or truncating values on read. Values are already bounded when
  stored, and a partial value misleads while debugging.
