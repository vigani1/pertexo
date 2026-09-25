import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT,
  FailureNotificationDestinationConfigSchema,
  type FailureNotificationDestinationConfig,
} from '@pertexo/workflow-model/failure-notification';

import type { DatabaseConfig } from '../config.js';
import {
  audit,
  authorize,
  claimCommand,
  completeCommand,
  destinationError,
  type CommandMetadata,
  type DestinationTransaction,
  type IdempotentCommandMetadata,
} from './failure-notification-destination-commands.js';
import {
  decodeFailureNotificationDestinationReplay,
  mapFailureNotificationDestinationRecord,
  readFailureNotificationDestination,
  serializeFailureNotificationDestinationRecord,
  type FailureNotificationDestinationRecord,
} from './failure-notification-destination-records.js';
import {
  clearWorkflowFailureNotificationPolicy,
  readWorkflowFailureNotificationPolicy,
  setWorkflowFailureNotificationPolicy,
} from './workflow-failure-notification-policies.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';

export { FailureNotificationDestinationError } from './failure-notification-destination-errors.js';
export type { FailureNotificationDestinationRecord } from './failure-notification-destination-records.js';

type DestinationConfig = FailureNotificationDestinationConfig;

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
  getWorkflowPolicy(
    input: CommandMetadata & Readonly<{ workflowId: string }>,
  ): Promise<FailureNotificationDestinationRecord | null>;
  close(): Promise<void>;
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
    ) => setWorkflowFailureNotificationPolicy(transaction, input),
    clearWorkflowPolicy: (
      input: Parameters<
        FailureNotificationDestinationDatabase['clearWorkflowPolicy']
      >[0],
    ) => clearWorkflowFailureNotificationPolicy(transaction, input),
    getWorkflowPolicy: (
      input: Parameters<
        FailureNotificationDestinationDatabase['getWorkflowPolicy']
      >[0],
    ) => readWorkflowFailureNotificationPolicy(transaction, input),
    close: () => lease.close(),
  });
}
