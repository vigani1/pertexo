import { createHash, randomUUID } from 'node:crypto';

import { createConnectionDatabase } from '../../../../src/connections/store.js';
import { generatePersistedId } from '@pertexo/database/platform';

import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
} from '../../../../src/attempts/contract.js';
import {
  actorId,
  apiBaseUrl,
  asOwner,
  asRuntime,
  checkpoint,
  databaseUrl,
  insertRun,
  nodeAttemptStore,
  ownedDeliveryStore,
  parseDatabaseConfig,
  workerBaseUrl,
  workflowA,
  workspaceA,
} from '../../../runs/run-store/fixtures.js';

export const sealedHealthSecret = (marker = 1) => ({
  kmsKeyReference: 'kms-owned-health-fixture',
  encryptedDataKey: Buffer.alloc(96, marker).toString('base64url'),
  ciphertext: Buffer.from(`encrypted-owned-${String(marker)}`).toString(
    'base64url',
  ),
  nonce: Buffer.alloc(12, marker).toString('base64url'),
  tag: Buffer.alloc(16, marker).toString('base64url'),
});

export async function withHealthApi<T>(
  operation: (api: ReturnType<typeof createConnectionDatabase>) => Promise<T>,
): Promise<T> {
  const api = createConnectionDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl) }),
  );
  try {
    return await operation(api);
  } finally {
    await api.close();
  }
}

export type HealthConnectionFixture = Readonly<{
  connectionId: string;
  secretVersionId: string;
  versionId: string;
}>;

export async function createHealthConnection(
  publishedSlot: 'slack_bot_token' | 'primary' = 'slack_bot_token',
): Promise<HealthConnectionFixture> {
  await asOwner(workspaceA, (client) =>
    client.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status)
    values($1,$2,'owner','active') on conflict(workspace_id,user_id) do nothing`,
      [workspaceA, actorId],
    ),
  );
  const connectionId = generatePersistedId();
  const secretVersionId = randomUUID();
  await withHealthApi((api) =>
    api.createConnection({
      workspaceId: workspaceA,
      actorId,
      connectionId,
      secretVersionId,
      providerKey: 'slack',
      authType: 'slack_bot_token',
      name: `Health ${connectionId}`,
      sealed: sealedHealthSecret(),
      idempotencyKey: `create-${connectionId}`,
      requestHash: 'a'.repeat(64),
    }),
  );
  const versionId = randomUUID();
  await asOwner(workspaceA, async (client) => {
    await client.query(
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
                id: 'slack-node',
                definition: { key: 'slack.send_message', version: 1 },
                connectionRefs: { [publishedSlot]: connectionId },
              },
            ],
            edges: [],
          },
        }),
        actorId,
      ],
    );
  });
  return Object.freeze({ connectionId, secretVersionId, versionId });
}

/** Real coordinator admission and worker lease; privileged writes seed only publication. */
export async function claimHealthAttempt(
  connection: HealthConnectionFixture,
): Promise<NodeAttemptLease> {
  const runId = await insertRun({ workflowVersionId: connection.versionId });
  const invocationKey = `${connection.versionId}|slack-node|b:|i:`;
  const committed = await ownedDeliveryStore.commitAdvancePlan({
    signal: new AbortController().signal,
    workspaceId: workspaceA,
    runId,
    workflowVersionId: connection.versionId,
    plan: {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        workflowVersionId: connection.versionId,
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 4,
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId: 'slack-node',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      events: [
        {
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-10-01T00:00:00.000Z',
        },
        {
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-10-01T00:00:00.000Z',
          invocationKey,
          nodeId: 'slack-node',
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: [
        { invocationKey, nodeId: 'slack-node', sideEffectClass: 'unsafe' },
      ],
      attempts: [
        {
          invocationKey,
          nodeId: 'slack-node',
          attemptNumber: 1,
          sideEffectClass: 'unsafe',
        },
      ],
    },
  });
  if (
    committed.kind !== 'committed' ||
    committed.admittedAttempts[0] === undefined
  )
    throw new Error('Health attempt admission missing');
  const attempt = committed.admittedAttempts[0];
  const rows = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{ id: string; payload_checksum: string }>(
      `select id,payload_checksum from app.outbox_events where workspace_id=$1 and aggregate_id=$2 and job_name='execute-node-attempt'`,
      [workspaceA, attempt.attemptId],
    ),
  );
  const outbox = rows.rows[0];
  if (outbox === undefined) throw new Error('Health attempt delivery missing');
  const claimed = await nodeAttemptStore.claimDelivery({
    signal: new AbortController().signal,
    workspaceId: workspaceA,
    runId,
    nodeRunId: attempt.nodeRunId,
    attemptId: attempt.attemptId,
    delivery: {
      outboxEventId: outbox.id,
      payloadChecksum: outbox.payload_checksum,
    },
    leaseDurationSeconds: 300,
    workerId: `health-${attempt.attemptId}`,
  });
  if (claimed.kind !== 'claimed')
    throw new Error('Health attempt lease missing');
  return claimed.lease;
}

export function markHealthDispatched(
  lease: NodeAttemptLease,
  connection: HealthConnectionFixture,
) {
  return nodeAttemptStore.markDispatched({
    signal: new AbortController().signal,
    lease,
    connectionFence: {
      connectionId: connection.connectionId,
      expectedProviderKey: 'slack',
      expectedAuthType: 'slack_bot_token',
      secretVersionId: connection.secretVersionId,
    },
    providerDispatchBinding: `slack:sha256:${'a'.repeat(64)}`,
  });
}

export type HealthCompletionInput = Parameters<
  NodeAttemptRunStore['complete']
>[0];

export function healthCompletion(
  lease: NodeAttemptLease,
  kind: 'healthy' | 'reauthorization_required' = 'reauthorization_required',
): HealthCompletionInput {
  return {
    lease,
    signal: new AbortController().signal,
    connectionHealthObservation:
      kind === 'healthy'
        ? { kind }
        : { kind, reasonCode: 'connection.slack_token_revoked' },
    outcome:
      kind === 'healthy'
        ? {
            status: 'succeeded',
            output: { channelId: 'COWNED', messageTs: '1724412345.000100' },
          }
        : {
            status: 'executor_failure',
            failureKind: 'failed',
            errorKind: 'authentication',
            possiblyDispatched: false,
            safeErrorCode: 'execution.authentication',
          },
  };
}
