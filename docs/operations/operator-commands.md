# Operator commands

Every change here is audited: it records who ran it, why, and its outcome, in the workspace
it touches. These commands are for the rare case the product can't settle by itself, such as
a crash that leaves it unsure whether a step already had its effect. They run from the
[single-server install](single-server.md).

## Before you start

Use a shell you can throw away (the scripts turn on `set -e`, which closes it on the first
failed command) and load the helpers. `run_ops` takes the operation lock, so it won't run during
a deploy or backup, and refuses while a restore or migration is unfinished:

```sh
bash
export PERTEXO_BETA_ROOT=/opt/pertexo
source /opt/pertexo/repository/infrastructure/single-server/common.sh
```

Every command needs these, shown in each example below:

| Field | What to put |
| --- | --- |
| `OPERATOR_COMMAND_ID` | A new UUID from `uuidgen`. Running the same ID and fields again returns the first answer and does nothing new. Other fields with that ID are refused. |
| `OPERATOR_ACTOR_REF` | Who you are, such as an email address. |
| `OPERATOR_WORKSPACE_ID` | The workspace that holds the thing you're changing. |
| `OPERATOR_REASON` | Why, in a sentence. It goes in the audit record. |

**Try it first.** Commands that change something need `OPERATOR_DRY_RUN`. With `true`, a dry run
reports what would happen and changes nothing. Use a new command ID for the real run.

## Finding the IDs

The IDs come from the database. Run this to get a shell you can query with, as the bootstrap
superuser, which reads across workspaces. Only read here:

```sh
select_release "$(cat /opt/pertexo/state/current)"
compose exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Runs with no recent change, and each one's current attempt with what `attempt.reconcile` needs
as `OPERATOR_EXPECTED_FENCE_TOKEN`:

```sql
SELECT r.workspace_id, r.id AS run_id, r.status, r.updated_at,
       a.id AS attempt_id, a.status AS attempt_status, a.fence_token, a.lease_expires_at
FROM app.workflow_runs r
LEFT JOIN app.node_runs n ON n.workspace_id = r.workspace_id AND n.workflow_run_id = r.id
LEFT JOIN app.node_attempts a ON a.workspace_id = n.workspace_id AND a.node_run_id = n.id
  AND a.status IN ('running', 'outcome_unknown')
WHERE r.status IN ('queued', 'running', 'waiting')
ORDER BY r.updated_at
LIMIT 50;
```

Messages that gave up on the queue:

```sql
SELECT workspace_id, id AS outbox_event_id, job_name, last_error_code, failed_at
FROM app.outbox_events WHERE failed_at IS NOT NULL AND published_at IS NULL
ORDER BY failed_at DESC LIMIT 50;
```

## `operator.status`

Use this when you want to know what an earlier command did: it reads one command back and
changes nothing. It answers with its stored outcome, or with `not_found`.

```sh
run_ops \
  -e OPERATOR_COMMAND_TYPE=operator.status \
  -e OPERATOR_COMMAND_ID=<id-of-the-earlier-command> \
  -e OPERATOR_ACTOR_REF=<you> \
  -e OPERATOR_WORKSPACE_ID=<workspace-id> \
  -e OPERATOR_REASON='Check an earlier command'
```

## `attempt.reconcile`

Use this when an attempt says `running`, but its worker is gone and its lease has expired, so
nothing will finish it. Choose what's true of the step:

- `reclaim` runs the step again. It's refused (`reclaim_unsafe`) when the step may already have
  had an unsafe side effect, because a second run could repeat it.
- `outcome_unknown` records that nobody knows whether it took effect, and the run moves on.
  Use this for anything you can't safely repeat, then find out what happened and record it with
  `unknown-outcome.record-evidence`.

Other outcomes: `would_reclaim` and `would_mark_unknown` from a dry run, `lease_active` when the
worker may still be alive, `fence_conflict` when the attempt has moved on (read the token again),
`not_running`, `not_found`.

```sh
run_ops \
  -e OPERATOR_COMMAND_TYPE=attempt.reconcile \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<you> \
  -e OPERATOR_WORKSPACE_ID=<workspace-id> \
  -e OPERATOR_REASON='Worker died during this attempt' \
  -e OPERATOR_ATTEMPT_ID=<attempt-id> \
  -e OPERATOR_EXPECTED_FENCE_TOKEN=<fence-token> \
  -e OPERATOR_ATTEMPT_ACTION=reclaim \
  -e OPERATOR_DRY_RUN=true
```

## `unknown-outcome.record-evidence`

Use this when you've found out what happened to an attempt marked `outcome_unknown`, for example by
asking the other system. It adds your evidence to the attempt's record so the next person can see it.
It doesn't change the run or take a dry run. Outcomes: `evidence_recorded`, `not_unknown`, `not_found`.

```sh
run_ops \
  -e OPERATOR_COMMAND_TYPE=unknown-outcome.record-evidence \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<you> \
  -e OPERATOR_WORKSPACE_ID=<workspace-id> \
  -e OPERATOR_REASON='Provider confirmed the charge went through' \
  -e OPERATOR_ATTEMPT_ID=<attempt-id> \
  -e OPERATOR_EVIDENCE_KIND=provider.confirmation \
  -e OPERATOR_EVIDENCE_REF=<evidence-json>
```

`OPERATOR_EVIDENCE_REF` is a JSON object saying where the proof is, such as
`'{"ticket":"SUP-123"}'`. Don't put secrets or customer data in it.

## `outbox.redispatch`

Use this when a message to the queue used up its publish attempts, usually after a Redis outage,
which leaves its run `queued`. It sets that one message to be sent again. Outcomes: `would_redispatch`
from a dry run, `redispatched`, `already_published`, `not_failed`, `not_found`.

```sh
run_ops \
  -e OPERATOR_COMMAND_TYPE=outbox.redispatch \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<you> \
  -e OPERATOR_WORKSPACE_ID=<workspace-id> \
  -e OPERATOR_REASON='Redis was down when this was published' \
  -e OPERATOR_OUTBOX_EVENT_ID=<outbox-event-id> \
  -e OPERATOR_DRY_RUN=true
```

## `due-work.resume`

Use this when a run's wait or retry time has passed but it hasn't moved on, such as after a long
outage. It queues the work that's due. Outcomes: `would_resume` from a dry run, `resumed`, `not_due`
when nothing is due yet, `terminal` when the run has finished, `not_found`.

```sh
run_ops \
  -e OPERATOR_COMMAND_TYPE=due-work.resume \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<you> \
  -e OPERATOR_WORKSPACE_ID=<workspace-id> \
  -e OPERATOR_REASON='Timer passed during the outage' \
  -e OPERATOR_RUN_ID=<run-id> \
  -e OPERATOR_DRY_RUN=true
```

## `run.cancel`

Use this when a run has to stop and nobody can do it from the app. It asks the run to cancel, and
the worker carries that out. Outcomes: `would_cancel` from a dry run, `cancel_requested`,
`already_requested`, `terminal`, `not_found`.

```sh
run_ops \
  -e OPERATOR_COMMAND_TYPE=run.cancel \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<you> \
  -e OPERATOR_WORKSPACE_ID=<workspace-id> \
  -e OPERATOR_REASON='Runaway run reported by the workspace owner' \
  -e OPERATOR_RUN_ID=<run-id> \
  -e OPERATOR_DRY_RUN=true
```

## `run.replay`

Use this when a finished run has to run again, with input you give, on a version of the same
workflow. It starts a new run, and everything in it happens again, including messages and charges.
Prefer **Replay** in the app when you can. Outcomes: `would_request` from a dry run,
`replay_requested`, `source_not_found`, `version_not_executable`, `workflow_mismatch`.

```sh
run_ops \
  -e OPERATOR_COMMAND_TYPE=run.replay \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<you> \
  -e OPERATOR_WORKSPACE_ID=<workspace-id> \
  -e OPERATOR_REASON='Replay after correcting the source data' \
  -e OPERATOR_RUN_ID=<source-run-id> \
  -e OPERATOR_WORKFLOW_VERSION_ID=<workflow-version-id> \
  -e OPERATOR_RUN_INPUT=<run-input-json> \
  -e OPERATOR_DRY_RUN=true
```

`OPERATOR_RUN_INPUT` is JSON of at most 64 KiB, such as `'{"orderId":42}'`.

## `trigger.reconcile`

Use this when a published workflow's trigger isn't taking effect, such as a schedule that doesn't
fire or a webhook still being set up, usually after an outage during publishing. It asks the worker
to set the published version's triggers up again. Outcomes: `would_retry` from a dry run,
`retry_requested`, `not_published`, `not_found`.

```sh
run_ops \
  -e OPERATOR_COMMAND_TYPE=trigger.reconcile \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<you> \
  -e OPERATOR_WORKSPACE_ID=<workspace-id> \
  -e OPERATOR_REASON='Publish happened during a Redis outage' \
  -e OPERATOR_WORKFLOW_ID=<workflow-id> \
  -e OPERATOR_DRY_RUN=true
```

## Other operator work

- **Lost two-factor device:** see [Two-factor sign-in](../guides/two-factor-sign-in.md#operator-recovery).
- **Mail with an unknown outcome:** see [System mail](system-mail.md).
