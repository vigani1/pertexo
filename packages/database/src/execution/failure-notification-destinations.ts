import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { createHash } from 'node:crypto';

import { generatePersistedId } from '../platform/persisted-id.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT,
  FailureNotificationDestinationConfigSchema,
  type FailureNotificationDestinationConfig,
} from '@pertexo/workflow-model/failure-notification';

import type { DatabaseConfig } from '../config.js';
import {
  FailureNotificationDestinationError,
  type FailureNotificationDestinationErrorCode,
} from './failure-notification-destination-errors.js';
import {
  decodeFailureNotificationDestinationReplay,
  mapFailureNotificationDestinationRecord,
  readFailureNotificationDestination,
  serializeFailureNotificationDestinationRecord,
  type FailureNotificationDestinationRecord,
} from './failure-notification-destination-records.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';
import { sha256HexSchema as digestSchema } from '../validation/persisted-primitives.js';

export { FailureNotificationDestinationError } from './failure-notification-destination-errors.js';
export type { FailureNotificationDestinationRecord } from './failure-notification-destination-records.js';

type DestinationConfig = FailureNotificationDestinationConfig;

type CommandMetadata = Readonly<{
  workspaceId: string;
  actorId: string;
  requestId?: string;
  traceId?: string;
}>;

type IdempotentCommandMetadata = CommandMetadata &
  Readonly<{
    idempotencyKey: string;
    requestHash: string;
  }>;

type DestinationAuditTarget = Readonly<{
  id: string;
  type: 'failure_notification_destination' | 'workflow';
}>;

type DestinationTransaction = <T>(
  input: CommandMetadata,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

export interface FailureNotificationDestinationDatabase {
  create(
    input: IdempotentCommandMetadata &
      Readonly<{
        destinationId: string;
        config: DestinationConfig;
      }>,
  ): Promise<FailureNotificationDestinationRecord>;
  get(
    input: CommandMetadata & Readonly<{ destinationId: string }>,
  ): Promise<FailureNotificationDestinationRecord>;
  list(
    input: CommandMetadata,
  ): Promise<readonly FailureNotificationDestinationRecord[]>;
  appendVersion(
    input: IdempotentCommandMetadata &
      Readonly<{
        destinationId: string;
        expectedVersion: number;
        config: DestinationConfig;
      }>,
  ): Promise<FailureNotificationDestinationRecord>;
  setStatus(
    input: IdempotentCommandMetadata &
      Readonly<{
        destinationId: string;
        status: 'enabled' | 'disabled';
      }>,
  ): Promise<FailureNotificationDestinationRecord>;
  setWorkflowPolicy(
    input: IdempotentCommandMetadata &
      Readonly<{
        workflowId: string;
        destinationId: string;
      }>,
  ): Promise<void>;
  clearWorkflowPolicy(
    input: IdempotentCommandMetadata & Readonly<{ workflowId: string }>,
  ): Promise<void>;
  close(): Promise<void>;
}

function destinationError(
  code: FailureNotificationDestinationErrorCode,
  message: string,
): FailureNotificationDestinationError {
  return new FailureNotificationDestinationError(code, message);
}

const replaySchema = z
  .object({
    schemaVersion: z.literal(1),
    result: z.unknown(),
  })
  .strict();

function keyDigest(value: string): string {
  return createHash('sha256')
    .update(z.string().min(1).max(256).parse(value))
    .digest('hex');
}

async function claimCommand(
  client: PoolClient,
  input: IdempotentCommandMetadata,
  operation: string,
  scope: string,
  resourceId: string,
): Promise<
  Readonly<{ kind: 'new' }> | Readonly<{ kind: 'replay'; result: unknown }>
> {
  const keyHash = keyDigest(input.idempotencyKey);
  const requestHash = digestSchema.parse(input.requestHash);
  await client.query(
    `insert into app.idempotency_records
       (id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
     values ($1,$2,$3,$4,$5,$6,'in_progress',$7,'{}'::jsonb)
     on conflict (workspace_id,operation,scope,key_hash) do nothing`,
    [
      generatePersistedId(),
      input.workspaceId,
      operation,
      scope,
      keyHash,
      requestHash,
      resourceId,
    ],
  );
  const result = await client.query<{
    request_hash: string;
    status: string;
    result_ref: unknown;
  }>(
    `select request_hash,status,result_ref from app.idempotency_records
      where workspace_id=$1 and operation=$2 and scope=$3 and key_hash=$4
      for update`,
    [input.workspaceId, operation, scope, keyHash],
  );
  const claim = result.rows[0];
  if (claim === undefined)
    throw new Error('Destination idempotency claim is unavailable');
  if (claim.request_hash !== requestHash)
    throw destinationError(
      'idempotency_conflict',
      'Idempotency key request mismatch',
    );
  if (claim.status !== 'completed') return Object.freeze({ kind: 'new' });
  return Object.freeze({
    kind: 'replay',
    result: replaySchema.parse(claim.result_ref).result,
  });
}

async function completeCommand(
  client: PoolClient,
  input: IdempotentCommandMetadata,
  operation: string,
  scope: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `update app.idempotency_records
        set status='completed',result_ref=$1::jsonb,updated_at=transaction_timestamp()
      where workspace_id=$2 and operation=$3 and scope=$4 and key_hash=$5`,
    [
      JSON.stringify({ schemaVersion: 1, result }),
      input.workspaceId,
      operation,
      scope,
      keyDigest(input.idempotencyKey),
    ],
  );
}

async function authorize(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  manage: boolean,
): Promise<void> {
  const roles = manage ? ['owner', 'admin'] : ['owner', 'admin', 'builder'];
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
       join app.workspaces workspace on workspace.id=membership.workspace_id
       join app.users actor on actor.id=membership.user_id
      where membership.workspace_id=$1 and membership.user_id=$2
        and membership.status='active' and membership.role=any($3::text[])
        and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId, roles],
  );
  if (result.rowCount !== 1)
    throw destinationError('not_found', 'Destination is not visible');
}

async function assertConnection(
  client: PoolClient,
  workspaceId: string,
  config: DestinationConfig,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.connections
      where workspace_id=$1 and id=$2 and status='active'
        and provider_key=$3 and auth_type=$4 for share`,
    [
      workspaceId,
      config.connectionId,
      config.kind,
      config.kind === 'slack' ? 'slack_bot_token' : 'resend_api_key',
    ],
  );
  if (result.rowCount !== 1)
    throw destinationError('not_found', 'Connection is not visible');
}

async function audit(
  client: PoolClient,
  input: CommandMetadata,
  action: string,
  target: DestinationAuditTarget,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      action,
      target.type,
      target.id,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify(metadata),
    ],
  );
}

async function insertVersion(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    destinationId: string;
    version: number;
    config: DestinationConfig;
    actorId: string;
  }>,
): Promise<void> {
  const { kind, ...config } = input.config;
  await client.query(
    `insert into app.failure_notification_destination_versions
       (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      input.workspaceId,
      input.destinationId,
      input.version,
      kind,
      kind === 'slack' ? 'unsafe' : 'idempotent_with_key',
      JSON.stringify(config),
      input.actorId,
    ],
  );
}

async function setDestinationStatus(
  transaction: DestinationTransaction,
  input: Parameters<FailureNotificationDestinationDatabase['setStatus']>[0],
): Promise<FailureNotificationDestinationRecord> {
  return transaction(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, true);
    const destinationId = z.uuid().parse(input.destinationId);
    const operation = 'failure.notification.destination.status';
    const scope = `${input.actorId}:${destinationId}`;
    const replay = await claimCommand(
      client,
      input,
      operation,
      scope,
      destinationId,
    );
    if (replay.kind === 'replay')
      return decodeFailureNotificationDestinationReplay(replay.result);
    const current = await readFailureNotificationDestination(
      client,
      input.workspaceId,
      destinationId,
      true,
    );
    if (current.status === input.status) {
      await completeCommand(
        client,
        input,
        operation,
        scope,
        serializeFailureNotificationDestinationRecord(current),
      );
      return current;
    }
    await client.query(
      `update app.failure_notification_destinations set status=$3,updated_at=clock_timestamp() where workspace_id=$1 and id=$2`,
      [input.workspaceId, current.id, input.status],
    );
    await audit(
      client,
      input,
      `failure_notification_destination.${input.status}`,
      { id: current.id, type: 'failure_notification_destination' },
      {},
    );
    const updated = await readFailureNotificationDestination(
      client,
      input.workspaceId,
      current.id,
    );
    await completeCommand(
      client,
      input,
      operation,
      scope,
      serializeFailureNotificationDestinationRecord(updated),
    );
    return updated;
  });
}

export function createFailureNotificationDestinationDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): FailureNotificationDestinationDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const transaction = <T>(
    input: CommandMetadata,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withTenantScopedClient(
      pool,
      {
        workspaceId: z.uuid().parse(input.workspaceId),
        actorId: z.uuid().parse(input.actorId),
      },
      work,
    );
  return Object.freeze({
    create: (
      input: Parameters<FailureNotificationDestinationDatabase['create']>[0],
    ) =>
      transaction(input, async (client) => {
        await authorize(client, input.workspaceId, input.actorId, true);
        const destinationId = z.uuid().parse(input.destinationId);
        const parsed = FailureNotificationDestinationConfigSchema.parse(
          input.config,
        );
        const operation = 'failure.notification.destination.create';
        const scope = input.actorId;
        const replay = await claimCommand(
          client,
          input,
          operation,
          scope,
          destinationId,
        );
        if (replay.kind === 'replay')
          return decodeFailureNotificationDestinationReplay(replay.result);
        await assertConnection(client, input.workspaceId, parsed);
        await client.query(
          `insert into app.failure_notification_destinations
           (id,workspace_id,kind,status,current_config_version,created_by)
         values ($1,$2,$3,'enabled',1,$4)`,
          [destinationId, input.workspaceId, parsed.kind, input.actorId],
        );
        await insertVersion(client, {
          workspaceId: input.workspaceId,
          destinationId,
          version: 1,
          config: parsed,
          actorId: input.actorId,
        });
        await audit(
          client,
          input,
          'failure_notification_destination.created',
          { id: destinationId, type: 'failure_notification_destination' },
          { kind: parsed.kind, version: 1 },
        );
        const created = await readFailureNotificationDestination(
          client,
          input.workspaceId,
          destinationId,
        );
        await completeCommand(
          client,
          input,
          operation,
          scope,
          serializeFailureNotificationDestinationRecord(created),
        );
        return created;
      }),
    get: (
      input: Parameters<FailureNotificationDestinationDatabase['get']>[0],
    ) =>
      transaction(input, async (client) => {
        await authorize(client, input.workspaceId, input.actorId, false);
        return readFailureNotificationDestination(
          client,
          input.workspaceId,
          input.destinationId,
        );
      }),
    list: (
      input: Parameters<FailureNotificationDestinationDatabase['list']>[0],
    ) =>
      transaction(input, async (client) => {
        await authorize(client, input.workspaceId, input.actorId, false);
        const result = await client.query<Record<string, unknown>>(
          `select destination.id,destination.workspace_id,destination.kind,
                  destination.status,destination.current_config_version,
                  destination.created_at,destination.updated_at,version.config
           from app.failure_notification_destinations destination
           join app.failure_notification_destination_versions version
             on version.workspace_id=destination.workspace_id
            and version.destination_id=destination.id
            and version.version=destination.current_config_version
          where destination.workspace_id=$1 order by destination.created_at,destination.id limit $2`,
          [input.workspaceId, FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT],
        );
        return Object.freeze(
          result.rows.map(mapFailureNotificationDestinationRecord),
        );
      }),
    appendVersion: (
      input: Parameters<
        FailureNotificationDestinationDatabase['appendVersion']
      >[0],
    ) =>
      transaction(input, async (client) => {
        await authorize(client, input.workspaceId, input.actorId, true);
        const destinationId = z.uuid().parse(input.destinationId);
        const operation = 'failure.notification.destination.version.append';
        const scope = `${input.actorId}:${destinationId}`;
        const replay = await claimCommand(
          client,
          input,
          operation,
          scope,
          destinationId,
        );
        if (replay.kind === 'replay')
          return decodeFailureNotificationDestinationReplay(replay.result);
        const current = await readFailureNotificationDestination(
          client,
          input.workspaceId,
          destinationId,
          true,
        );
        const parsed = FailureNotificationDestinationConfigSchema.parse(
          input.config,
        );
        if (
          current.currentVersion !== input.expectedVersion ||
          current.kind !== parsed.kind
        )
          throw destinationError('conflict', 'Destination version conflict');
        await assertConnection(client, input.workspaceId, parsed);
        const next = current.currentVersion + 1;
        await insertVersion(client, {
          workspaceId: input.workspaceId,
          destinationId: current.id,
          version: next,
          config: parsed,
          actorId: input.actorId,
        });
        await client.query(
          `update app.failure_notification_destinations
            set current_config_version=$3,updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
          [input.workspaceId, current.id, next],
        );
        await audit(
          client,
          input,
          'failure_notification_destination.version_appended',
          { id: current.id, type: 'failure_notification_destination' },
          { version: next },
        );
        const appended = await readFailureNotificationDestination(
          client,
          input.workspaceId,
          current.id,
        );
        await completeCommand(
          client,
          input,
          operation,
          scope,
          serializeFailureNotificationDestinationRecord(appended),
        );
        return appended;
      }),
    setStatus: (
      input: Parameters<FailureNotificationDestinationDatabase['setStatus']>[0],
    ) => setDestinationStatus(transaction, input),
    setWorkflowPolicy: (
      input: Parameters<
        FailureNotificationDestinationDatabase['setWorkflowPolicy']
      >[0],
    ) =>
      transaction(input, async (client) => {
        await authorize(client, input.workspaceId, input.actorId, false);
        const workflowId = z.uuid().parse(input.workflowId);
        const operation = 'workflow.failure.notification.policy.set';
        const scope = `${input.actorId}:${workflowId}`;
        const replay = await claimCommand(
          client,
          input,
          operation,
          scope,
          workflowId,
        );
        if (replay.kind === 'replay') return;
        await readFailureNotificationDestination(
          client,
          input.workspaceId,
          input.destinationId,
        );
        const result = await client.query(
          `insert into app.workflow_failure_notification_policies
           (workspace_id,workflow_id,destination_id,updated_by)
         select $1,workflow.id,$3,$4 from app.workflows workflow
          join app.failure_notification_destinations destination
            on destination.workspace_id=workflow.workspace_id and destination.id=$3
         where workflow.workspace_id=$1 and workflow.id=$2 and destination.status='enabled'
         on conflict (workflow_id) do update set destination_id=excluded.destination_id,
           updated_by=excluded.updated_by,updated_at=clock_timestamp()`,
          [input.workspaceId, workflowId, input.destinationId, input.actorId],
        );
        if (result.rowCount !== 1)
          throw destinationError(
            'not_found',
            'Workflow or destination is not visible',
          );
        await audit(
          client,
          input,
          'workflow.failure_notification_policy_set',
          { id: workflowId, type: 'workflow' },
          { destinationId: input.destinationId },
        );
        await completeCommand(client, input, operation, scope, null);
      }),
    clearWorkflowPolicy: (
      input: Parameters<
        FailureNotificationDestinationDatabase['clearWorkflowPolicy']
      >[0],
    ) =>
      transaction(input, async (client) => {
        await authorize(client, input.workspaceId, input.actorId, false);
        const workflowId = z.uuid().parse(input.workflowId);
        const operation = 'workflow.failure.notification.policy.clear';
        const scope = `${input.actorId}:${workflowId}`;
        const replay = await claimCommand(
          client,
          input,
          operation,
          scope,
          workflowId,
        );
        if (replay.kind === 'replay') return;
        const workflow = await client.query(
          `select id from app.workflows
            where workspace_id=$1 and id=$2 for share`,
          [input.workspaceId, workflowId],
        );
        if (workflow.rowCount !== 1)
          throw destinationError('not_found', 'Workflow is not visible');
        const result = await client.query(
          `delete from app.workflow_failure_notification_policies where workspace_id=$1 and workflow_id=$2`,
          [input.workspaceId, workflowId],
        );
        if (result.rowCount === 1)
          await audit(
            client,
            input,
            'workflow.failure_notification_policy_cleared',
            { id: workflowId, type: 'workflow' },
            {},
          );
        await completeCommand(client, input, operation, scope, null);
      }),
    close: () => lease.close(),
  });
}
