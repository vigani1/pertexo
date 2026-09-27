import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  FailureNotificationDestinationConfigSchema,
  type FailureNotificationDestinationConfig,
} from '@pertexo/workflow-model/failure-notification';

import { FailureNotificationDestinationError } from './failure-notification-destination-errors.js';

export type FailureNotificationDestinationRecord = Readonly<{
  id: string;
  workspaceId: string;
  kind: 'slack' | 'email';
  status: 'enabled' | 'disabled';
  currentVersion: number;
  config: FailureNotificationDestinationConfig;
  createdAt: Date;
  updatedAt: Date;
}>;

const destinationReplaySchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    kind: z.enum(['slack', 'email']),
    status: z.enum(['enabled', 'disabled']),
    currentVersion: z.number().int().positive(),
    config: FailureNotificationDestinationConfigSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine((record) => record.kind === record.config.kind, {
    message: 'Destination kind does not match replayed configuration',
    path: ['config', 'kind'],
  });

function destinationNotFound(): FailureNotificationDestinationError {
  return new FailureNotificationDestinationError(
    'not_found',
    'Destination is not visible',
  );
}

export function serializeFailureNotificationDestinationRecord(
  record: FailureNotificationDestinationRecord,
) {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function decodeFailureNotificationDestinationReplay(
  value: unknown,
): FailureNotificationDestinationRecord {
  const parsed = destinationReplaySchema.parse(value);
  return Object.freeze({
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  });
}

export function mapFailureNotificationDestinationRecord(
  row: Readonly<Record<string, unknown>>,
): FailureNotificationDestinationRecord {
  const kind = z.enum(['slack', 'email']).parse(row.kind);
  const stored = z.record(z.string(), z.unknown()).parse(row.config);
  if (stored.kind !== undefined && stored.kind !== kind)
    throw new Error('Destination kind does not match persisted configuration');
  return Object.freeze({
    id: z.uuid().parse(row.id),
    workspaceId: z.uuid().parse(row.workspace_id),
    kind,
    status: z.enum(['enabled', 'disabled']).parse(row.status),
    currentVersion: z
      .number()
      .int()
      .positive()
      .parse(row.current_config_version),
    config: FailureNotificationDestinationConfigSchema.parse({
      ...stored,
      kind,
    }),
    createdAt: z.date().parse(row.created_at),
    updatedAt: z.date().parse(row.updated_at),
  });
}

export async function readFailureNotificationDestination(
  client: PoolClient,
  workspaceId: string,
  destinationId: string,
  lock = false,
): Promise<FailureNotificationDestinationRecord> {
  const parsedDestinationId = z.uuid().parse(destinationId);
  if (lock) {
    const locked = await client.query(
      `select id from app.failure_notification_destinations
        where workspace_id=$1 and id=$2 for update`,
      [workspaceId, parsedDestinationId],
    );
    if (locked.rowCount !== 1) throw destinationNotFound();
  }
  const result = await client.query<Record<string, unknown>>(
    `select destination.id,destination.workspace_id,destination.kind,
            destination.status,destination.current_config_version,
            destination.created_at,destination.updated_at,version.config
       from app.failure_notification_destinations destination
       join app.failure_notification_destination_versions version
         on version.workspace_id=destination.workspace_id
        and version.destination_id=destination.id
        and version.version=destination.current_config_version
      where destination.workspace_id=$1 and destination.id=$2`,
    [workspaceId, parsedDestinationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw destinationNotFound();
  return mapFailureNotificationDestinationRecord(row);
}
