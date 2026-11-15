import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readSystemMailRecipient } from '../delivery/system-mail-recipient.repository.js';
import { FailureNotificationDestinationError } from './notification-destination.errors.js';
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
  insertDestination,
  insertVersion,
  lockNotificationConnection,
  setCurrentDestinationVersion,
  updateDestinationStatus,
} from './manage.repository.js';
import { readFailureNotificationDestination } from './read-destination.js';
import {
  decodeFailureNotificationDestinationReplay,
  serializeFailureNotificationDestinationRecord,
} from './replay.js';

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
  await insertDestination(client, {
    destinationId,
    workspaceId: input.workspaceId,
    kind: config.kind,
    actorId: input.actorId,
  });
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
  await setCurrentDestinationVersion(
    client,
    input.workspaceId,
    current.id,
    next,
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
  await updateDestinationStatus(
    client,
    input.workspaceId,
    current.id,
    input.status,
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
  const connection = await lockNotificationConnection(
    client,
    workspaceId,
    config,
  );
  if (!eligibleNotificationConnection(config.kind, connection))
    throw new FailureNotificationDestinationError(
      'not_found',
      'Connection is not visible',
    );
  return connection.auth_type;
}
