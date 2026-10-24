import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT,
  FailureNotificationDestinationConfigSchema,
} from '@pertexo/workflow-model';
import type { DatabaseConfig } from '../../config.js';
import {
  audit,
  authorize,
  claimNotificationCommand,
  completeNotificationCommand,
  destinationError,
  type CommandMetadata,
  type DestinationTransaction,
} from './commands.repository.js';
import {
  decodeFailureNotificationDestinationReplay,
  mapFailureNotificationDestinationRecord,
  readFailureNotificationDestination,
  serializeFailureNotificationDestinationRecord,
  type FailureNotificationDestinationRecord,
} from './records.queries.js';
import {
  clearWorkflowFailureNotificationPolicy,
  readWorkflowFailureNotificationPolicy,
  setWorkflowFailureNotificationPolicy,
} from '../policies/settings.repository.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import type {
  DestinationConfig,
  FailureNotificationDestinationDatabase,
} from './contract.js';
export { FailureNotificationDestinationError } from './errors.js';
export type { FailureNotificationDestinationRecord } from './records.queries.js';

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
    await authorize(client, input.workspaceId, input.actorId, { manage: true });
    const destinationId = z.uuid().parse(input.destinationId);
    const operation = 'failure.notification.destination.status';
    const scope = `${input.actorId}:${destinationId}`;
    const replay = await claimNotificationCommand(client, input, {
      operation,
      scope,
      resourceId: destinationId,
    });
    if (replay.kind === 'replay')
      return decodeFailureNotificationDestinationReplay(replay.result);
    const current = await readFailureNotificationDestination(
      client,
      input.workspaceId,
      destinationId,
      { lock: true },
    );
    if (current.status === input.status) {
      await completeNotificationCommand(client, input, {
        operation,
        scope,
        result: serializeFailureNotificationDestinationRecord(current),
      });
      return current;
    }
    await client.query(
      `update app.failure_notification_destinations set status=$3,updated_at=clock_timestamp() where workspace_id=$1 and id=$2`,
      [input.workspaceId, current.id, input.status],
    );
    await audit(client, input, {
      action: `failure_notification_destination.${input.status}`,
      target: { id: current.id, type: 'failure_notification_destination' },
      metadata: {},
    });
    const updated = await readFailureNotificationDestination(
      client,
      input.workspaceId,
      current.id,
    );
    await completeNotificationCommand(client, input, {
      operation,
      scope,
      result: serializeFailureNotificationDestinationRecord(updated),
    });
    return updated;
  });
}

export function createFailureNotificationDestinationDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): FailureNotificationDestinationDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;

  const transact: DestinationTransaction = (input, work) =>
    transaction(pool, input, work);
  return Object.freeze({
    create: (
      input: Parameters<FailureNotificationDestinationDatabase['create']>[0],
    ) => createNotificationDestination(transact, input),
    get: (
      input: Parameters<FailureNotificationDestinationDatabase['get']>[0],
    ) => readNotificationDestination(transact, input),
    list: (
      input: Parameters<FailureNotificationDestinationDatabase['list']>[0],
    ) => listNotificationDestinations(transact, input),
    appendVersion: (
      input: Parameters<
        FailureNotificationDestinationDatabase['appendVersion']
      >[0],
    ) => appendNotificationDestinationVersion(transact, input),
    setStatus: (
      input: Parameters<FailureNotificationDestinationDatabase['setStatus']>[0],
    ) => setDestinationStatus(transact, input),
    setWorkflowPolicy: (
      input: Parameters<
        FailureNotificationDestinationDatabase['setWorkflowPolicy']
      >[0],
    ) => setWorkflowFailureNotificationPolicy(transact, input),
    clearWorkflowPolicy: (
      input: Parameters<
        FailureNotificationDestinationDatabase['clearWorkflowPolicy']
      >[0],
    ) => clearWorkflowFailureNotificationPolicy(transact, input),
    getWorkflowPolicy: (
      input: Parameters<
        FailureNotificationDestinationDatabase['getWorkflowPolicy']
      >[0],
    ) => readWorkflowFailureNotificationPolicy(transact, input),
    close: () => lease.close(),
  });
}

function transaction<T>(
  pool: Pool,
  input: CommandMetadata,
  work: (client: PoolClient) => Promise<T>,
) {
  return withTenantScopedClient(
    pool,
    {
      workspaceId: z.uuid().parse(input.workspaceId),
      actorId: z.uuid().parse(input.actorId),
    },
    work,
  );
}

function createNotificationDestination(
  transact: DestinationTransaction,
  input: Parameters<FailureNotificationDestinationDatabase['create']>[0],
): ReturnType<FailureNotificationDestinationDatabase['create']> {
  return transact(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: true,
    });
    const destinationId = z.uuid().parse(input.destinationId);
    const parsed = FailureNotificationDestinationConfigSchema.parse(
      input.config,
    );
    const operation = 'failure.notification.destination.create';
    const scope = input.actorId;
    const replay = await claimNotificationCommand(client, input, {
      operation,
      scope,
      resourceId: destinationId,
    });
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
    await audit(client, input, {
      action: 'failure_notification_destination.created',
      target: {
        id: destinationId,
        type: 'failure_notification_destination',
      },
      metadata: { kind: parsed.kind, version: 1 },
    });
    const created = await readFailureNotificationDestination(
      client,
      input.workspaceId,
      destinationId,
    );
    await completeNotificationCommand(client, input, {
      operation,
      scope,
      result: serializeFailureNotificationDestinationRecord(created),
    });
    return created;
  });
}

function readNotificationDestination(
  transact: DestinationTransaction,
  input: Parameters<FailureNotificationDestinationDatabase['get']>[0],
): ReturnType<FailureNotificationDestinationDatabase['get']> {
  return transact(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: false,
    });
    return readFailureNotificationDestination(
      client,
      input.workspaceId,
      input.destinationId,
    );
  });
}

function listNotificationDestinations(
  transact: DestinationTransaction,
  input: Parameters<FailureNotificationDestinationDatabase['list']>[0],
): ReturnType<FailureNotificationDestinationDatabase['list']> {
  return transact(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: false,
    });
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
  });
}

function appendNotificationDestinationVersion(
  transact: DestinationTransaction,
  input: Parameters<FailureNotificationDestinationDatabase['appendVersion']>[0],
): ReturnType<FailureNotificationDestinationDatabase['appendVersion']> {
  return transact(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: true,
    });
    const destinationId = z.uuid().parse(input.destinationId);
    const operation = 'failure.notification.destination.version.append';
    const scope = `${input.actorId}:${destinationId}`;
    const replay = await claimNotificationCommand(client, input, {
      operation,
      scope,
      resourceId: destinationId,
    });
    if (replay.kind === 'replay')
      return decodeFailureNotificationDestinationReplay(replay.result);
    const current = await readFailureNotificationDestination(
      client,
      input.workspaceId,
      destinationId,
      { lock: true },
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
    await audit(client, input, {
      action: 'failure_notification_destination.version_appended',
      target: { id: current.id, type: 'failure_notification_destination' },
      metadata: { version: next },
    });
    const appended = await readFailureNotificationDestination(
      client,
      input.workspaceId,
      current.id,
    );
    await completeNotificationCommand(client, input, {
      operation,
      scope,
      result: serializeFailureNotificationDestinationRecord(appended),
    });
    return appended;
  });
}
