import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { expect } from 'vitest';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  composeExecutableCatalog,
  verifyWorkflowExecutable,
} from '@pertexo/workflow-engine';
import { workflowGraphSchema } from '@pertexo/contracts';

const scheduleExecutableCatalog = composeExecutableCatalog(
  PLATFORM_NODE_CATALOG,
);
export const scheduleScopeSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
});
export const scheduleEvidenceSchema = scheduleScopeSchema.extend({
  triggerId: z.uuid(),
  runId: z.uuid(),
  scheduleId: z.uuid(),
  outerId: z.uuid(),
  innerId: z.uuid(),
  leafId: z.uuid(),
  occurrenceId: z.uuid(),
  scheduledAt: z.iso.datetime().regex(/\.\d{6}Z$/u),
  firstDueAt: z.iso.datetime().regex(/\.\d{3}Z$/u),
  publishKey: z.uuid(),
  disableKey: z.uuid(),
});
type Scope = z.infer<typeof scheduleScopeSchema>;

/** Known endpoint representations only; never round away microseconds. */
export function verifiedScheduleAcceptanceInstant(
  firstDueAt: string,
  scheduledAt: string,
) {
  z.iso
    .datetime()
    .regex(/\.\d{3}Z$/u)
    .parse(firstDueAt);
  z.iso
    .datetime()
    .regex(/\.\d{6}Z$/u)
    .parse(scheduledAt);
  if (scheduledAt !== `${firstDueAt.slice(0, -1)}000Z`)
    throw new Error(
      'Schedule occurrence does not match the captured due instant',
    );
  return firstDueAt;
}

/** Actual database clock and durable publication, never workstation due inference. */
export async function observeScheduleBeforeDue(database: Pool, scope: Scope) {
  const result = await database.query<{
    id: string;
    anchor_at: Date;
    next_fire_at: Date;
    config_fingerprint: string;
    observed_at: Date;
    before_due: boolean;
    remaining_seconds: number;
  }>(
    `with observation as materialized (select clock_timestamp() as observed_at)
     select trigger.id,schedule.anchor_at,schedule.next_fire_at,schedule.config_fingerprint,
            observation.observed_at,schedule.next_fire_at>observation.observed_at before_due,
            extract(epoch from schedule.next_fire_at-observation.observed_at)::double precision remaining_seconds
       from app.workflow_triggers trigger
       join app.trigger_schedules schedule on schedule.trigger_id=trigger.id
       join app.workflows workflow on workflow.id=trigger.workflow_id and workflow.workspace_id=trigger.workspace_id
       cross join observation
      where trigger.workspace_id=$1 and trigger.workflow_id=$2 and trigger.workflow_version_id=$3
        and workflow.published_version_id=$3 and trigger.kind='schedule' and trigger.status='active'
        and schedule.status='enabled' and schedule.interval_minutes=1
        and schedule.last_fire_at is null and schedule.lease_token is null`,
    [scope.workspaceId, scope.workflowId, scope.workflowVersionId],
  );
  expect(result.rows).toHaveLength(1);
  const schedule = result.rows[0];
  if (schedule === undefined)
    throw new Error('Owned schedule missing before due');
  expect(schedule.before_due).toBe(true);
  expect(schedule.remaining_seconds).toBeGreaterThan(20);
  expect(schedule.next_fire_at.getTime() - schedule.anchor_at.getTime()).toBe(
    60_000,
  );
  const facts = await database.query<{
    runs: number;
    occurrences: number;
    receipts: number;
  }>(
    `select (select count(*)::int from app.workflow_runs where workspace_id=$1 and workflow_id=$2) runs,
            (select count(*)::int from app.trigger_schedule_occurrences where workspace_id=$1 and trigger_id=$3) occurrences,
            (select count(*)::int from app.inbox_receipts receipt join app.outbox_events event on event.id=receipt.message_id
              where event.workspace_id=$1 and event.aggregate_id=$2 and event.job_name='reconcile-workflow-triggers'
              and receipt.consumer_name='trigger-runtime.reconciliation.v1' and receipt.completed_at is not null) receipts`,
    [scope.workspaceId, scope.workflowId, schedule.id],
  );
  expect(facts.rows).toEqual([{ runs: 0, occurrences: 0, receipts: 1 }]);
  return {
    triggerId: schedule.id,
    anchorAt: schedule.anchor_at.toISOString(),
    nextFireAt: schedule.next_fire_at.toISOString(),
    fingerprint: schedule.config_fingerprint,
    observedAt: schedule.observed_at.toISOString(),
  };
}

export async function verifyScheduleEvidence(
  database: Pool,
  evidence: z.infer<typeof scheduleEvidenceSchema>,
) {
  const acceptanceInstant = verifiedScheduleAcceptanceInstant(
    evidence.firstDueAt,
    evidence.scheduledAt,
  );
  const scope = [evidence.workspaceId, evidence.workflowId];
  const versions = await database.query<{
    id: string;
    graph_json: unknown;
    checksum: string;
    executable_json: unknown;
  }>(
    'select id,graph_json,checksum,executable_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2',
    scope,
  );
  expect(versions.rows).toHaveLength(1);
  const version = versions.rows[0];
  if (version === undefined) throw new Error('Owned immutable version missing');
  expect(version.id).toBe(evidence.workflowVersionId);
  verifyWorkflowExecutable({
    envelope: version.executable_json,
    checksum: version.checksum,
    catalog: scheduleExecutableCatalog,
  });
  const graph = workflowGraphSchema.parse(version.graph_json);
  const draft = await database.query<{ graph_json: unknown }>(
    'select graph_json from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
    scope,
  );
  expect(draft.rows).toHaveLength(1);
  expect(workflowGraphSchema.parse(draft.rows[0]?.graph_json)).toEqual(graph);
  expect(graph.nodes).toHaveLength(2);
  expect(
    graph.nodes.find((node) => node.id === evidence.scheduleId),
  ).toMatchObject({
    definition: { key: 'core.schedule', version: 1 },
    config: {
      kind: 'interval',
      intervalMinutes: 1,
      misfirePolicy: 'catch_up_once',
    },
  });
  const outer = graph.nodes.find((node) => node.id === evidence.outerId);
  expect(outer).toMatchObject({
    structured: { maxIterations: 2, maxConcurrency: 1 },
  });
  expect(outer?.structured?.body.nodes[0]).toMatchObject({
    id: evidence.innerId,
    structured: { maxIterations: 2, maxConcurrency: 1 },
  });
  expect(outer?.structured?.body.nodes[0]?.structured?.body.nodes[0]?.id).toBe(
    evidence.leafId,
  );
  const runs = await database.query(
    'select id,status,trigger_type,workflow_version_id from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
    scope,
  );
  expect(runs.rows).toEqual([
    {
      id: evidence.runId,
      status: 'succeeded',
      trigger_type: 'schedule',
      workflow_version_id: evidence.workflowVersionId,
    },
  ]);
  const occurrences = await database.query<{
    id: string;
    scheduled_at: string;
    outcome: string;
    workflow_run_id: string;
  }>(
    `select id,to_char(scheduled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') scheduled_at,
            disposition as outcome,workflow_run_id from app.trigger_schedule_occurrences where workspace_id=$1 and trigger_id=$2`,
    [evidence.workspaceId, evidence.triggerId],
  );
  expect(occurrences.rows).toEqual([
    {
      id: evidence.occurrenceId,
      scheduled_at: evidence.scheduledAt,
      outcome: 'accepted',
      workflow_run_id: evidence.runId,
    },
  ]);
  const schedules = await database.query(
    'select status,lease_token from app.trigger_schedules where workspace_id=$1 and trigger_id=$2',
    [evidence.workspaceId, evidence.triggerId],
  );
  expect(schedules.rows).toEqual([{ status: 'disabled', lease_token: null }]);
  const nodes = await database.query<{
    node_id: string;
    status: string;
    invocation_key: string;
    branch_context: unknown;
    input_ref: unknown;
    output_ref: unknown;
  }>(
    'select node_id,status,invocation_key,branch_context,input_ref,output_ref from app.node_runs where workspace_id=$1 and workflow_run_id=$2',
    [evidence.workspaceId, evidence.runId],
  );
  expect(nodes.rows).toHaveLength(8);
  expect(nodes.rows.every((node) => node.status === 'succeeded')).toBe(true);
  const leaves = nodes.rows.filter((node) => node.node_id === evidence.leafId);
  expect(leaves).toHaveLength(4);
  expect(new Set(leaves.map((node) => node.invocation_key)).size).toBe(4);
  for (const [outerOrdinal, group] of [
    ['north-0', 'north-1'],
    ['south-0', 'south-1'],
  ].entries()) {
    for (const [innerOrdinal, item] of group.entries()) {
      const payload = {
        kind: 'inline',
        value: { item, ordinal: innerOrdinal },
      };
      const partialPayload: unknown = expect.objectContaining(payload);
      expect(leaves).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            branch_context: {
              branchPath: [],
              iterationPath: [
                { loopNodeId: evidence.outerId, ordinal: outerOrdinal },
                { loopNodeId: evidence.innerId, ordinal: innerOrdinal },
              ],
            },
            input_ref: partialPayload,
            output_ref: partialPayload,
          }),
        ]),
      );
    }
  }
  const receipts = await database.query(
    "select operation,status,key_hash from app.idempotency_records where workspace_id=$1 and operation in ('workflow.publish','workflow.run.accept','schedule.trigger.setenabled') order by operation",
    [evidence.workspaceId],
  );
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  expect(receipts.rows).toEqual([
    {
      operation: 'schedule.trigger.setenabled',
      status: 'completed',
      key_hash: hash(evidence.disableKey),
    },
    {
      operation: 'workflow.publish',
      status: 'completed',
      key_hash: hash(evidence.publishKey),
    },
    {
      operation: 'workflow.run.accept',
      status: 'completed',
      key_hash: hash(`${evidence.triggerId}:${acceptanceInstant}`),
    },
  ]);
  const events = await database.query(
    "select type,count(*)::int count from app.run_events where workspace_id=$1 and workflow_run_id=$2 and type in ('run.queued','run.started','run.succeeded') group by type order by type collate \"C\"",
    [evidence.workspaceId, evidence.runId],
  );
  expect(events.rows).toEqual([
    { type: 'run.queued', count: 1 },
    { type: 'run.started', count: 1 },
    { type: 'run.succeeded', count: 1 },
  ]);
  const audits = await database.query(
    "select action,count(*)::int count from app.audit_events where workspace_id=$1 and action in ('workflow.published','run.start_accepted','schedule_trigger.disabled') group by action order by action collate \"C\"",
    [evidence.workspaceId],
  );
  // Scheduled admission has no manual API run.start_accepted audit.
  expect(audits.rows).toEqual([
    { action: 'schedule_trigger.disabled', count: 1 },
    { action: 'workflow.published', count: 1 },
  ]);
  const checkpoints = await database.query(
    'select count(*)::int count from app.run_checkpoints where workspace_id=$1 and workflow_run_id=$2',
    [evidence.workspaceId, evidence.runId],
  );
  expect(checkpoints.rows).toEqual([{ count: 1 }]);
  const reconciliation = await database.query(
    `select count(*)::int events,count(receipt.completed_at)::int completed
       from app.outbox_events event left join app.inbox_receipts receipt
         on receipt.message_id=event.id and receipt.consumer_name='trigger-runtime.reconciliation.v1'
      where event.workspace_id=$1 and event.aggregate_id=$2 and event.job_name='reconcile-workflow-triggers'`,
    scope,
  );
  expect(reconciliation.rows).toEqual([{ events: 1, completed: 1 }]);
}
