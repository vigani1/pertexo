import type { Pool } from 'pg';
import { expect } from 'vitest';
import type { z } from 'zod';
import { workflowGraphSchema } from '@pertexo/contracts';

import { verifyWorkflowExecutable } from '@pertexo/workflow-engine';
import type { httpEvidenceSchema, httpEffectsSchema } from './scope.js';
import {
  executable,
  httpActionBody,
  hash,
  verifyHttpAccepted,
} from './scope.js';
import { verifyFailedStepRecovery } from './recovery.js';

export async function verifyHttpEvidence(
  database: Pool,
  evidence: z.infer<typeof httpEvidenceSchema>,
  effects: z.infer<typeof httpEffectsSchema>,
) {
  expect(effects).toEqual({
    phase: 'controlled-http-effects',
    requests: 7,
    effects: 6,
    bodyHashes: [
      hash(httpActionBody),
      hash(JSON.stringify({ marker: 'recovery-once' })),
      hash(JSON.stringify({ marker: 'recovery-unknown' })),
      hash(JSON.stringify({ marker: 'recovery-unknown' })),
      hash(JSON.stringify({ marker: 'recovery-network-loss' })),
      hash(JSON.stringify({ marker: 'recovery-network-loss' })),
    ],
  });
  expect(evidence.trueRunId).not.toBe(evidence.falseRunId);
  const versions = await database.query<{
    id: string;
    graph_json: unknown;
    executable_json: unknown;
    checksum: string;
  }>(
    'select id,graph_json,executable_json,checksum from app.workflow_versions where workspace_id=$1 and workflow_id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(versions.rows).toHaveLength(1);
  const version = versions.rows[0];
  if (version === undefined) throw new Error('Owned HTTP version missing');
  expect(version.id).toBe(evidence.workflowVersionId);
  verifyWorkflowExecutable({
    envelope: version.executable_json,
    checksum: version.checksum,
    catalog: executable,
  });
  const graph = workflowGraphSchema.parse(version.graph_json);
  expect(graph.nodes.map(({ definition }) => definition.key).sort()).toEqual([
    'core.condition',
    'core.set',
    'core.terminate',
    'core.validate',
    'core.webhook',
    'http.request',
  ]);
  expect(graph.nodes.find(({ id }) => id === evidence.httpId)).toMatchObject({
    connectionRefs: { http_headers: evidence.connectionId },
    config: {
      method: 'POST',
      maxRedirects: 0,
      url: 'https://pertexo-controlled-action.example.test/effect',
    },
    inputMappings: {
      body: { kind: 'run_input', path: '$.body' },
    },
  });
  expect(graph.edges).toHaveLength(5);
  expect(
    graph.edges.find(({ target }) => target.nodeId === evidence.httpId),
  ).toMatchObject({ source: { nodeId: evidence.conditionId, port: 'true' } });
  const drafts = await database.query<{ graph_json: unknown }>(
    'select graph_json from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(drafts.rows).toHaveLength(1);
  expect(workflowGraphSchema.parse(drafts.rows[0]?.graph_json)).toEqual(graph);
  const runs = await database.query(
    'select id,status,trigger_type,workflow_version_id from app.workflow_runs where workspace_id=$1 and workflow_id=$2 and id=any($3::uuid[]) order by id',
    [
      evidence.workspaceId,
      evidence.workflowId,
      [evidence.trueRunId, evidence.falseRunId],
    ],
  );
  expect(runs.rows).toEqual(
    [evidence.trueRunId, evidence.falseRunId].sort().map((id) => ({
      id,
      status: 'succeeded',
      trigger_type: 'webhook',
      workflow_version_id: evidence.workflowVersionId,
    })),
  );
  for (const runId of [evidence.trueRunId, evidence.falseRunId]) {
    await verifyHttpAccepted(database, evidence, runId);
    const events = await database.query(
      "select type,count(*)::int count from app.run_events where workspace_id=$1 and workflow_run_id=$2 and type in ('run.queued','run.started','run.succeeded') group by type order by type collate \"C\"",
      [evidence.workspaceId, runId],
    );
    expect(events.rows).toEqual([
      { type: 'run.queued', count: 1 },
      { type: 'run.started', count: 1 },
      { type: 'run.succeeded', count: 1 },
    ]);
  }
  const deliveries = await database.query<{
    id: string;
    outcome: string;
    http_status: number;
    signature_check: string;
    replay_check: string;
    workflow_run_id: string | null;
  }>(
    `select delivery.id,delivery.outcome,delivery.http_status,delivery.signature_check,delivery.replay_check,delivery.workflow_run_id
       from app.webhook_trigger_deliveries delivery
       join app.webhook_trigger_endpoints endpoint on endpoint.workspace_id=delivery.workspace_id and endpoint.id=delivery.endpoint_id
       join app.workflow_triggers trigger on trigger.workspace_id=endpoint.workspace_id and trigger.workflow_id=endpoint.workflow_id and trigger.node_id=endpoint.node_id
      where delivery.workspace_id=$1 and trigger.id=$2`,
    [evidence.workspaceId, evidence.triggerId],
  );
  expect(deliveries.rows).toHaveLength(4);
  expect(deliveries.rows.map(({ outcome }) => outcome).sort()).toEqual([
    'accepted',
    'accepted',
    'conflict',
    'replayed',
  ]);
  for (const row of deliveries.rows)
    expect(row).toMatchObject({
      http_status: row.outcome === 'conflict' ? 409 : 202,
      signature_check: 'verified',
      replay_check: expectedReplayCheck(row.outcome),
    });
  expect(
    deliveries.rows
      .filter(({ outcome }) => outcome === 'accepted')
      .map(({ workflow_run_id }) => workflow_run_id)
      .sort(),
  ).toEqual([evidence.trueRunId, evidence.falseRunId].sort());
  expect(
    deliveries.rows.find(({ outcome }) => outcome === 'replayed')
      ?.workflow_run_id,
  ).toBe(evidence.trueRunId);
  expect(
    deliveries.rows.find(({ outcome }) => outcome === 'conflict')
      ?.workflow_run_id,
  ).toBeNull();
  const replays = await database.query(
    'select workflow_run_id from app.webhook_trigger_replay_records where workspace_id=$1 and workflow_run_id=any($2::uuid[]) order by workflow_run_id',
    [evidence.workspaceId, [evidence.trueRunId, evidence.falseRunId]],
  );
  expect(replays.rows).toEqual(
    [evidence.trueRunId, evidence.falseRunId]
      .sort()
      .map((workflow_run_id) => ({ workflow_run_id })),
  );
  const receipts = await database.query(
    'select operation,status,key_hash,resource_id from app.idempotency_records where workspace_id=$1 and operation=any($2::text[]) and resource_id=any($3::uuid[]) order by operation,key_hash',
    [
      evidence.workspaceId,
      ['workflow.publish', 'workflow.run.accept', 'webhook.trigger.provision'],
      [
        evidence.workflowId,
        evidence.triggerId,
        evidence.trueRunId,
        evidence.falseRunId,
      ],
    ],
  );
  const accepted = deliveries.rows.filter(
    ({ outcome }) => outcome === 'accepted',
  );
  expect(receipts.rows).toEqual([
    {
      operation: 'webhook.trigger.provision',
      status: 'completed',
      key_hash: hash(evidence.provisionKey),
      resource_id: evidence.triggerId,
    },
    {
      operation: 'workflow.publish',
      status: 'completed',
      key_hash: hash(evidence.publishKey),
      resource_id: evidence.workflowId,
    },
    ...accepted
      .map((row) => ({
        operation: 'workflow.run.accept',
        status: 'completed',
        key_hash: hash(row.id),
        resource_id: row.workflow_run_id,
      }))
      .sort((left, right) => left.key_hash.localeCompare(right.key_hash)),
  ]);
  const nodes = await database.query(
    'select node_id,status from app.node_runs where workspace_id=$1 and workflow_run_id=$2',
    [evidence.workspaceId, evidence.trueRunId],
  );
  expect(nodes.rows).toHaveLength(6);
  expect(nodes.rows.every(({ status }) => status === 'succeeded')).toBe(true);
  const attempts = await database.query(
    'select attempt.attempt_number,attempt.status,attempt.side_effect_class,attempt.dispatch_marked_at is not null dispatched,node.provider_dispatch_binding is not null binding from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id and node.workspace_id=attempt.workspace_id where node.workspace_id=$1 and node.workflow_run_id=any($2::uuid[]) and node.node_id=$3',
    [
      evidence.workspaceId,
      [evidence.trueRunId, evidence.falseRunId],
      evidence.httpId,
    ],
  );
  expect(attempts.rows).toEqual([
    {
      attempt_number: 1,
      status: 'succeeded',
      side_effect_class: 'unsafe',
      dispatched: true,
      binding: true,
    },
  ]);
  const audits = await database.query(
    "select action,count(*)::int count from app.audit_events where workspace_id=$1 and action in ('workflow.published','run.start_accepted') group by action",
    [evidence.workspaceId],
  );
  expect(audits.rows).toEqual([{ action: 'workflow.published', count: 1 }]);
  const reconciliation = await database.query(
    "select count(*)::int events,count(receipt.completed_at)::int completed from app.outbox_events event left join app.inbox_receipts receipt on receipt.message_id=event.id and receipt.consumer_name='trigger-runtime.reconciliation' where event.workspace_id=$1 and event.aggregate_id=$2 and event.job_name='reconcile-workflow-triggers'",
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(reconciliation.rows).toEqual([{ events: 1, completed: 1 }]);
  await verifyFailedStepRecovery(database, evidence);
}

function expectedReplayCheck(outcome: string) {
  if (outcome === 'accepted') return 'new';
  if (outcome === 'replayed') return 'duplicate';
  return 'conflict';
}
