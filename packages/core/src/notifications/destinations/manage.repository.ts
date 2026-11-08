import { readSystemMailRecipient } from '../delivery/system-mail-recipient.repository.js';
import { FailureNotificationDestinationError } from './notification-destination.errors.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  failureNotificationDestinations as destination,
  failureNotificationDestinationVersions as version,
} from '@pertexo/database/schema';
import { FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT } from '@pertexo/workflow-model';
import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import {
  notificationSideEffectClass,
  eligibleNotificationConnection,
} from './notification-policy.js';
import {
  audit,
  claimNotificationCommand,
  completeNotificationCommand,
} from './command.js';
import type {
  AppendDestinationVersionInput,
  CreateDestinationInput,
  DestinationConfig,
  FailureNotificationDestinationRecord,
  SetDestinationStatusInput,
} from './notification-destination.types.js';
import {
  destinationRecords,
  readFailureNotificationDestination,
} from './notification-destinations.repository.js';
import {
  decodeFailureNotificationDestinationReplay,
  serializeFailureNotificationDestinationRecord,
} from './replay.js';

export async function listDestinations(
  client: PoolClient,
  workspaceId: string,
  afterId?: string,
): Promise<readonly FailureNotificationDestinationRecord[]> {
  const result = await destinationRecords(drizzle(client))
    .where(
      and(
        eq(destination.workspaceId, workspaceId),
        afterId === undefined ? undefined : gt(destination.id, afterId),
      ),
    )
    .orderBy(destination.id)
    .limit(FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT)
    .catch(rethrowQueryFailure);
  return Object.freeze(result.map((row) => Object.freeze(row)));
}

export async function createDestination(
  client: PoolClient,
  input: CreateDestinationInput,
): Promise<FailureNotificationDestinationRecord> {
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
  const authType = await assertConnection(client, input.workspaceId, config);
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
    sideEffectClass: notificationSideEffectClass(config.kind, authType),
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
}

export async function appendDestinationVersion(
  client: PoolClient,
  input: AppendDestinationVersionInput,
): Promise<FailureNotificationDestinationRecord> {
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
    throw new FailureNotificationDestinationError(
      'conflict',
      'Destination version conflict',
    );
  const authType = await assertConnection(client, input.workspaceId, config);
  const next = current.currentVersion + 1;
  await insertVersion(client, {
    workspaceId: input.workspaceId,
    destinationId: current.id,
    version: next,
    sideEffectClass: notificationSideEffectClass(config.kind, authType),
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
}

export async function setDestinationStatus(
  client: PoolClient,
  input: SetDestinationStatusInput,
): Promise<FailureNotificationDestinationRecord> {
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
}

async function assertConnection(
  client: PoolClient,
  workspaceId: string,
  config: DestinationConfig,
): Promise<string> {
  if (config.kind === 'system_mail') {
    if (
      (await readSystemMailRecipient(
        drizzle(client),
        workspaceId,
        config.memberId,
      )) === undefined
    )
      throw new FailureNotificationDestinationError(
        'recipient_unavailable',
        'Recipient is not a current workspace member',
      );
    return 'system_mail';
  }
  const result = await drizzle(client)
    .select({
      auth_type: connections.authType,
      provider_key: connections.providerKey,
      status: connections.status,
    })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, config.connectionId),
        eq(connections.status, 'active'),
        eq(connections.providerKey, config.kind),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  if (!eligibleNotificationConnection(config.kind, result[0]))
    throw new FailureNotificationDestinationError(
      'not_found',
      'Connection is not visible',
    );
  return result[0].auth_type;
}

async function insertVersion(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    destinationId: string;
    version: number;
    sideEffectClass: 'unsafe' | 'idempotent_with_key';
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
      sideEffectClass: input.sideEffectClass,
      config,
      createdBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
}
