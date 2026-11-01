import { FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  connections,
  failureNotificationDestinations as destination,
  failureNotificationDestinationVersions as version,
} from '@pertexo/database/schema';
import { notificationProviderRequirements } from '../policies/admission.queries.js';
import {
  clearWorkflowFailureNotificationPolicy,
  readWorkflowFailureNotificationPolicy,
  setWorkflowFailureNotificationPolicy,
} from '../policies/workflow-policy.js';
import {
  audit,
  authorize,
  claimNotificationCommand,
  completeNotificationCommand,
  destinationError,
} from './command.js';
import type {
  CommandMetadata,
  DestinationConfig,
  DestinationTransaction,
  NotificationDestinationStore,
  FailureNotificationDestinationRecord,
} from './contract.js';
import {
  destinationRecords,
  readFailureNotificationDestination,
} from './records.queries.js';
import {
  decodeFailureNotificationDestinationReplay,
  serializeFailureNotificationDestinationRecord,
} from './replay.js';

async function assertConnection(
  client: PoolClient,
  workspaceId: string,
  config: DestinationConfig,
): Promise<void> {
  const result = await drizzle(client)
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, config.connectionId),
        eq(connections.status, 'active'),
        eq(connections.providerKey, config.kind),
        eq(
          connections.authType,
          notificationProviderRequirements[config.kind].authType,
        ),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  if (result.length !== 1)
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
  await drizzle(client)
    .insert(version)
    .values({
      workspaceId: input.workspaceId,
      destinationId: input.destinationId,
      version: input.version,
      kind,
      sideEffectClass: notificationProviderRequirements[kind].sideEffectClass,
      config,
      createdBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
}

async function setDestinationStatus(
  transaction: DestinationTransaction,
  input: Parameters<NotificationDestinationStore['setStatus']>[0],
): Promise<FailureNotificationDestinationRecord> {
  return transaction(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, { manage: true });
    const destinationId = input.destinationId;
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
    await drizzle(client)
      .update(destination)
      .set({ status: input.status, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(destination.workspaceId, input.workspaceId),
          eq(destination.id, current.id),
        ),
      )
      .catch(rethrowQueryFailure);
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

export function createNotificationDestinationStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): NotificationDestinationStore {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;

  const transact: DestinationTransaction = (input, work) =>
    transaction(pool, input, work);
  return Object.freeze({
    create: (input: Parameters<NotificationDestinationStore['create']>[0]) =>
      createNotificationDestination(transact, input),
    get: (input: Parameters<NotificationDestinationStore['get']>[0]) =>
      readNotificationDestination(transact, input),
    list: (input: Parameters<NotificationDestinationStore['list']>[0]) =>
      listNotificationDestinations(transact, input),
    appendVersion: (
      input: Parameters<NotificationDestinationStore['appendVersion']>[0],
    ) => appendNotificationDestinationVersion(transact, input),
    setStatus: (
      input: Parameters<NotificationDestinationStore['setStatus']>[0],
    ) => setDestinationStatus(transact, input),
    setWorkflowPolicy: (
      input: Parameters<NotificationDestinationStore['setWorkflowPolicy']>[0],
    ) => setWorkflowFailureNotificationPolicy(transact, input),
    clearWorkflowPolicy: (
      input: Parameters<NotificationDestinationStore['clearWorkflowPolicy']>[0],
    ) => clearWorkflowFailureNotificationPolicy(transact, input),
    getWorkflowPolicy: (
      input: Parameters<NotificationDestinationStore['getWorkflowPolicy']>[0],
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
      workspaceId: input.workspaceId,
      actorId: input.actorId,
    },
    work,
  );
}

function createNotificationDestination(
  transact: DestinationTransaction,
  input: Parameters<NotificationDestinationStore['create']>[0],
): ReturnType<NotificationDestinationStore['create']> {
  return transact(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: true,
    });
    const destinationId = input.destinationId;
    const config = input.config;
    const operation = 'failure.notification.destination.create';
    const scope = input.actorId;
    const replay = await claimNotificationCommand(client, input, {
      operation,
      scope,
      resourceId: destinationId,
    });
    if (replay.kind === 'replay')
      return decodeFailureNotificationDestinationReplay(replay.result);
    await assertConnection(client, input.workspaceId, config);
    await drizzle(client)
      .insert(destination)
      .values({
        id: destinationId,
        workspaceId: input.workspaceId,
        kind: config.kind,
        status: 'enabled',
        currentConfigVersion: 1,
        createdBy: input.actorId,
      })
      .catch(rethrowQueryFailure);
    await insertVersion(client, {
      workspaceId: input.workspaceId,
      destinationId,
      version: 1,
      config,
      actorId: input.actorId,
    });
    await audit(client, input, {
      action: 'failure_notification_destination.created',
      target: {
        id: destinationId,
        type: 'failure_notification_destination',
      },
      metadata: { kind: config.kind, version: 1 },
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
  input: Parameters<NotificationDestinationStore['get']>[0],
): ReturnType<NotificationDestinationStore['get']> {
  return transact(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: false,
      browsing: true,
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
  input: Parameters<NotificationDestinationStore['list']>[0],
): ReturnType<NotificationDestinationStore['list']> {
  return transact(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: false,
      browsing: true,
    });
    const result = await destinationRecords(drizzle(client))
      .where(eq(destination.workspaceId, input.workspaceId))
      .orderBy(destination.createdAt, destination.id)
      .limit(FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT)
      .catch(rethrowQueryFailure);
    return Object.freeze(result.map((row) => Object.freeze(row)));
  });
}

function appendNotificationDestinationVersion(
  transact: DestinationTransaction,
  input: Parameters<NotificationDestinationStore['appendVersion']>[0],
): ReturnType<NotificationDestinationStore['appendVersion']> {
  return transact(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: true,
    });
    const destinationId = input.destinationId;
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
    const config = input.config;
    if (
      current.currentVersion !== input.expectedVersion ||
      current.kind !== config.kind
    )
      throw destinationError('conflict', 'Destination version conflict');
    await assertConnection(client, input.workspaceId, config);
    const next = current.currentVersion + 1;
    await insertVersion(client, {
      workspaceId: input.workspaceId,
      destinationId: current.id,
      version: next,
      config,
      actorId: input.actorId,
    });
    await drizzle(client)
      .update(destination)
      .set({ currentConfigVersion: next, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(destination.workspaceId, input.workspaceId),
          eq(destination.id, current.id),
        ),
      )
      .catch(rethrowQueryFailure);
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
