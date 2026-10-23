import { createHash } from 'node:crypto';

import {
  actorId,
  asAdmin,
  asOwner,
  asRuntime,
  checkpoint,
  insertRun,
  nodeAttemptStore,
  randomUUID,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
  workflowA,
} from '../fixtures.js';

/** The input recorded on a node run, as stored. */
export async function storedNodeRunInput(nodeRunId: string): Promise<unknown> {
  const result = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{ input_ref: unknown }>(
      `select input_ref from app.node_runs
        where workspace_id=$1 and id=$2`,
      [workspaceA, nodeRunId],
    ),
  );
  return result.rows[0]?.input_ref;
}

export async function claimDispatchAttempt(
  nodeId: string,
  options: Readonly<{
    explicitEmptyScope?: boolean;
    control?: 'canceled' | 'timed_out';
    runInput?: unknown;
    sideEffectClass?: 'safe' | 'idempotent_with_key' | 'unsafe';
    workerId?: string;
    workflowVersionId?: string;
  }> = {},
) {
  const workflowVersionId = options.workflowVersionId ?? versionA;
  const runId = await insertRun({
    workflowVersionId,
    inputRef: {
      kind: 'inline',
      value: options.runInput ?? { nodeId },
    },
  });
  const invocationKey = `${workflowVersionId}|${nodeId}|b:|i:`;
  const committed = await ownedDeliveryStore.commitAdvancePlan({
    workspaceId: workspaceA,
    runId,
    workflowVersionId,
    signal: new AbortController().signal,
    plan: {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        workflowVersionId,
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 4,
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId,
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      events: [
        {
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
        {
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey,
          nodeId,
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: [
        {
          invocationKey,
          nodeId,
          sideEffectClass: options.sideEffectClass ?? 'unsafe',
        },
      ],
      attempts: [
        {
          invocationKey,
          nodeId,
          attemptNumber: 1,
          sideEffectClass: options.sideEffectClass ?? 'unsafe',
        },
      ],
    },
  });
  if (committed.kind !== 'committed')
    throw new Error('dispatch fixture did not commit');
  const admission = committed.admittedAttempts[0];
  if (admission === undefined) throw new Error('dispatch attempt missing');
  const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{ id: string; payload_checksum: string }>(
      `select id,payload_checksum from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='execute-node-attempt'`,
      [workspaceA, admission.attemptId],
    ),
  );
  const delivery = outbox.rows[0];
  if (delivery === undefined) throw new Error('dispatch delivery missing');
  if (options.explicitEmptyScope === true)
    await asAdmin((client) =>
      client.query(
        `update app.node_runs
            set branch_context='{"branchPath":[],"iterationPath":[]}'::jsonb
          where workspace_id=$1 and id=$2`,
        [workspaceA, admission.nodeRunId],
      ),
    );
  if (options.control !== undefined)
    await asAdmin((client) =>
      options.control === 'canceled'
        ? client.query(
            "update app.workflow_runs set cancel_requested_at=clock_timestamp(),cancel_requested_by=$2,cancel_reason='user_requested' where id=$1",
            [runId, actorId],
          )
        : client.query(
            'update app.workflow_runs set deadline_at=clock_timestamp() where id=$1',
            [runId],
          ),
    );
  const claimed = await nodeAttemptStore.claimDelivery({
    workspaceId: workspaceA,
    runId,
    nodeRunId: admission.nodeRunId,
    attemptId: admission.attemptId,
    delivery: {
      outboxEventId: delivery.id,
      payloadChecksum: delivery.payload_checksum,
    },
    leaseDurationSeconds: 30,
    workerId: options.workerId ?? `dispatch-worker-${nodeId}`,
    signal: new AbortController().signal,
  });
  if (claimed.kind !== 'claimed')
    throw new Error('dispatch attempt was not claimed');
  return claimed.lease;
}

export async function seedDispatchConnection(input: {
  connectionId: string;
  providerKey: 'http' | 'slack';
  authType: 'http_headers' | 'slack_bot_token';
  secretVersionId: string;
}) {
  await asOwner(workspaceA, async (client) => {
    await client.query(
      `insert into app.connections (
           id,workspace_id,provider_key,name,auth_type,status,
           current_secret_version_id,created_by
         ) values ($1,$2,$3,$4,$5,'active',$6,$7)`,
      [
        input.connectionId,
        workspaceA,
        input.providerKey,
        `Dispatch fence ${input.providerKey} ${input.connectionId}`,
        input.authType,
        input.secretVersionId,
        actorId,
      ],
    );
    await client.query(
      `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,'kms','a','a',$4,$5,$6)`,
      [
        input.secretVersionId,
        workspaceA,
        input.connectionId,
        'a'.repeat(16),
        'a'.repeat(22),
        actorId,
      ],
    );
  });
}

export function dispatchBinding(
  providerKey: 'http' | 'slack',
  connectionId: string,
  secretVersionId: string,
) {
  return `${providerKey}:sha256:${createHash('sha256')
    .update(`${providerKey}\0${connectionId}\0${secretVersionId}`)
    .digest('hex')}`;
}

export async function seedSlackDispatchPublication(connectionId: string) {
  const versionId = randomUUID();
  await asOwner(workspaceA, (client) =>
    client.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
     select $1,$2,$3,coalesce(max(version_number),0)+1,'{}'::jsonb,$4,$5::jsonb,$6
      from app.workflow_versions where workspace_id=$2 and workflow_id=$3`,
      [
        versionId,
        workspaceA,
        workflowA,
        `wf:sha256:${createHash('sha256').update(versionId).digest('hex')}`,
        JSON.stringify({
          graph: {
            nodes: [
              {
                id: 'dispatch-slack',
                definition: { key: 'slack.send_message', version: 1 },
                connectionRefs: { slack_bot_token: connectionId },
              },
            ],
            edges: [],
          },
        }),
        actorId,
      ],
    ),
  );
  return versionId;
}

export async function admitWaitAttempt(runId: string, invocationKey: string) {
  const committed = await ownedDeliveryStore.commitAdvancePlan({
    workspaceId: workspaceA,
    runId,
    workflowVersionId: versionA,
    signal: new AbortController().signal,
    plan: {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 4,
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId: 'wait',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      events: [
        {
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
        {
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey,
          nodeId: 'wait',
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: [
        { invocationKey, nodeId: 'wait', sideEffectClass: 'safe' },
      ],
      attempts: [
        {
          admissionKind: 'execute',
          invocationKey,
          nodeId: 'wait',
          attemptNumber: 1,
          sideEffectClass: 'safe',
        },
      ],
    },
  });
  if (committed.kind !== 'committed') throw new Error('fixture did not commit');
  const admission = committed.admittedAttempts[0];
  if (admission === undefined) throw new Error('fixture attempt missing');
  const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{ id: string; payload_checksum: string }>(
      `select id,payload_checksum from app.outbox_events
           where workspace_id=$1 and aggregate_id=$2 and job_name='execute-node-attempt'`,
      [workspaceA, admission.attemptId],
    ),
  );
  const delivery = outbox.rows[0];
  if (delivery === undefined) throw new Error('fixture delivery missing');
  const claimed = await nodeAttemptStore.claimDelivery({
    workspaceId: workspaceA,
    runId,
    nodeRunId: admission.nodeRunId,
    attemptId: admission.attemptId,
    delivery: {
      outboxEventId: delivery.id,
      payloadChecksum: delivery.payload_checksum,
    },
    leaseDurationSeconds: 30,
    workerId: 'attempt-worker-wait',
    signal: new AbortController().signal,
  });
  if (claimed.kind !== 'claimed') throw new Error('attempt was not claimed');

  return { admission, claimed };
}
