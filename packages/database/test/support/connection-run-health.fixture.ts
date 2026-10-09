import { createHash, randomUUID } from 'node:crypto';
import { createOutboxDispatcherDatabase } from '../../src/outbox/dispatcher.js';
import type { PoolClient } from 'pg';

import { createApiConnectionDatabase } from '../../src/connections/database.js';
import { generatePersistedId } from '../../src/platform/persisted-id.js';
import { createWorkspaceDatabase } from '../../src/database.js';
import { applyConnectionHealthObservation } from '../../src/connections/health/observations.js';
import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
} from '../../src/attempts/contract.js';
import {
  actorId,
  asAdmin,
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
} from '../coordinator-run-store.fixtures.js';

export {
  actorId,
  asOwner,
  asRuntime,
  databaseUrl,
  nodeAttemptStore,
  workspaceA,
  workerBaseUrl,
};

export const sealedHealthSecret = (marker = 1) => ({
  schemaVersion: 1 as const,
  kmsKeyReference: 'kms-owned-health-fixture',
  encryptedDataKey: Buffer.alloc(96, marker).toString('base64url'),
  ciphertext: Buffer.from(`encrypted-owned-${String(marker)}`).toString(
    'base64url',
  ),
  nonce: Buffer.alloc(12, marker).toString('base64url'),
  tag: Buffer.alloc(16, marker).toString('base64url'),
});

export async function withHealthApi<T>(
  operation: (
    api: ReturnType<typeof createApiConnectionDatabase>,
  ) => Promise<T>,
): Promise<T> {
  const api = createApiConnectionDatabase(
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
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,schema_version,
      graph_json,checksum,executable_schema_version,executable_json,published_by)
      select $1,$2,$3,coalesce(max(version_number),0)+1,1,'{}'::jsonb,$4,2,$5::jsonb,$6
      from app.workflow_versions where workspace_id=$2 and workflow_id=$3`,
      [
        versionId,
        workspaceA,
        workflowA,
        `wf:v2:sha256:${createHash('sha256').update(versionId).digest('hex')}`,
        JSON.stringify({
          schemaVersion: 2,
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
          schemaVersion: 1,
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-10-01T00:00:00.000Z',
        },
        {
          schemaVersion: 1,
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
    providerDispatchBinding: `slack:v1:sha256:${'a'.repeat(64)}`,
  });
}

export type HealthCompletionInput = Parameters<
  NodeAttemptRunStore['complete']
>[0];
export function healthCompletion(
  lease: NodeAttemptLease,
  kind: 'healthy' | 'reauthorization_required' = 'reauthorization_required',
  mode: 'off' | 'observe' | 'enforce' = 'enforce',
): HealthCompletionInput {
  return {
    lease,
    signal: new AbortController().signal,
    connectionRunHealthMode: mode,
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

export async function healthCommand(lease: NodeAttemptLease) {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{
      observation_id: string;
      outbox_event_id: string;
      payload_checksum: string;
      production_mode: string;
    }>(
      `select observation.id observation_id,observation.outbox_event_id,outbox.payload_checksum,observation.production_mode
      from app.connection_health_observations observation join app.outbox_events outbox on outbox.id=observation.outbox_event_id
      where observation.workspace_id=$1 and observation.attempt_id=$2`,
      [workspaceA, lease.attemptId],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Accepted health command missing');
  return {
    workspaceId: workspaceA,
    observationId: row.observation_id,
    delivery: {
      outboxEventId: row.outbox_event_id,
      payloadChecksum: row.payload_checksum,
    },
  };
}

export async function applyHealthCommand(
  input: Awaited<ReturnType<typeof healthCommand>>,
  mode: 'off' | 'observe' | 'enforce' = 'enforce',
) {
  const database = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(workerBaseUrl) }),
  );
  try {
    return await applyConnectionHealthObservation(database, { ...input, mode });
  } finally {
    await database.close();
  }
}

export async function readHealth(connectionId: string) {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{
      status: string;
      health_revision: string;
      last_error_code: string | null;
      last_tested_at: Date | null;
      last_healthy_at: Date | null;
      last_run_observed_at: Date | null;
      current_secret_version_id: string;
    }>(
      `select status,health_revision,last_error_code,last_tested_at,last_healthy_at,last_run_observed_at,current_secret_version_id
      from app.connections where workspace_id=$1 and id=$2`,
      [workspaceA, connectionId],
    ),
  );
  return result.rows[0];
}

export async function testHealthConnection(
  connection: HealthConnectionFixture,
  outcome: 'success' | 'rejection' | 'inconclusive' = 'success',
  afterDispatch?: () => Promise<void>,
) {
  const common = {
    workspaceId: workspaceA,
    actorId,
    connectionId: connection.connectionId,
    idempotencyKey: `test-${randomUUID()}`,
    dispatchToken: randomUUID(),
    requestHash: 'b'.repeat(64),
    secretVersionId: connection.secretVersionId,
  };
  return withHealthApi(async (api) => {
    await api.startConnectionTest({ ...common, expectedProviderKey: 'slack' });
    await api.resolveConnectionTestSecret({
      ...common,
      expectedProviderKey: 'slack',
    });
    await api.markConnectionTestDispatched(common);
    await afterDispatch?.();
    return api.completeConnectionTest({
      ...common,
      outcome:
        outcome === 'success'
          ? { ok: true, httpStatus: 200 }
          : outcome === 'inconclusive'
            ? {
                ok: false,
                httpStatus: null,
                errorCode: 'connection.transport_failed',
                reauthorizationRequired: false,
              }
            : {
                ok: false,
                httpStatus: 200,
                errorCode: 'connection.slack_token_revoked',
                reauthorizationRequired: true,
              },
    });
  });
}

export async function rotateHealthConnection(
  connection: HealthConnectionFixture,
) {
  const secretVersionId = randomUUID();
  await withHealthApi((api) =>
    api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId,
      connectionId: connection.connectionId,
      expectedCurrentSecretVersionId: connection.secretVersionId,
      expectedAuthType: 'slack_bot_token',
      secretVersionId,
      sealed: sealedHealthSecret(2),
      idempotencyKey: `rotate-${randomUUID()}`,
      requestHash: 'c'.repeat(64),
    }),
  );
  return { ...connection, secretVersionId };
}

export async function revokeHealthConnection(
  connection: HealthConnectionFixture,
) {
  await withHealthApi((api) =>
    api.revokeConnection({
      workspaceId: workspaceA,
      actorId,
      connectionId: connection.connectionId,
    }),
  );
}

export async function countHealthTransitions(connectionId: string) {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{ count: number }>(
      `select count(*)::int count from app.connection_events
    where workspace_id=$1 and connection_id=$2 and event_type='connection.reauthorization_required' and metadata->>'source'='run'`,
      [workspaceA, connectionId],
    ),
  );
  return result.rows[0]?.count;
}

export async function withConnectionLock<T>(
  connectionId: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  return asOwner(workspaceA, async (client) => {
    await client.query(
      'select id from app.connections where workspace_id=$1 and id=$2 for update',
      [workspaceA, connectionId],
    );
    return operation(client);
  });
}

export function createHealthDispatcher() {
  return createOutboxDispatcherDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(
        process.env.DATABASE_MAINTENANCE_URL ??
          'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
      ),
    }),
  );
}

export async function readAcceptedHealthExecution(lease: NodeAttemptLease) {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{
      attempt: unknown;
      run: unknown;
    }>(
      `select row_to_json(attempt) attempt,row_to_json(run) run
     from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
     join app.workflow_runs run on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
     where attempt.workspace_id=$1 and attempt.id=$2`,
      [workspaceA, lease.attemptId],
    ),
  );
  return result.rows[0];
}

/** A fault on one fixture-owned row; normal runtime adapters still perform every write. */
export async function withHealthWriteFailure(
  target: 'publication' | 'transition',
  id: string,
  operation: () => Promise<void>,
) {
  if (!/^[\da-f-]{36}$/u.test(id)) throw new Error('Invalid fixture fault ID');
  const table =
    target === 'publication' ? 'outbox_events' : 'connection_events';
  const condition =
    target === 'publication'
      ? `NEW.id='${id}'::uuid AND NEW.published_at IS NOT NULL`
      : `NEW.connection_id='${id}'::uuid AND NEW.event_type='connection.reauthorization_required'`;
  await asAdmin(async (client) => {
    await client.query(`CREATE FUNCTION app.f30_owned_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'controlled F30 write failure' USING ERRCODE='40001'; END $$`);
    await client.query(`CREATE TRIGGER f30_owned_write_failure BEFORE ${target === 'publication' ? 'UPDATE' : 'INSERT'}
      ON app.${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION app.f30_owned_write_failure()`);
  });
  try {
    await operation();
  } finally {
    await asAdmin(async (client) => {
      await client.query(
        `DROP TRIGGER f30_owned_write_failure ON app.${table}`,
      );
      await client.query('DROP FUNCTION app.f30_owned_write_failure()');
    });
  }
}
