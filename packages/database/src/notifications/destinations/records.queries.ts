import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  failureNotificationDestinations as destination,
  failureNotificationDestinationVersions as version,
} from '../../schema/notifications.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  type FailureNotificationDestinationConfig,
  FailureNotificationDestinationConfigSchema,
} from '@pertexo/workflow-model';

import { FailureNotificationDestinationError } from './errors.js';

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

/** The FK and strict JSON check correlate the canonical kind with its config. */
export const destinationConfigSql = sql<FailureNotificationDestinationConfig>`${version.config} || jsonb_build_object('kind',${version.kind})`;
export function destinationRecords(db: Pick<NodePgDatabase, 'select'>) {
  return db
    .select({
      id: destination.id,
      workspaceId: destination.workspaceId,
      kind: destination.kind,
      status: destination.status,
      currentVersion: destination.currentConfigVersion,
      config: destinationConfigSql,
      createdAt: sql<Date>`${destination.createdAt}`.mapWith(
        (value: string) => new Date(value),
      ),
      updatedAt: sql<Date>`${destination.updatedAt}`.mapWith(
        (value: string) => new Date(value),
      ),
    })
    .from(destination)
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, destination.workspaceId),
        eq(version.destinationId, destination.id),
        eq(version.version, destination.currentConfigVersion),
      ),
    );
}

export async function readFailureNotificationDestination(
  client: PoolClient,
  workspaceId: string,
  destinationId: string,
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<FailureNotificationDestinationRecord> {
  const parsedDestinationId = z.uuid().parse(destinationId);
  const db = drizzle(client);
  const predicate = and(
    eq(destination.workspaceId, workspaceId),
    eq(destination.id, parsedDestinationId),
  );
  if (lock) {
    const locked = await db
      .select({ id: destination.id })
      .from(destination)
      .where(predicate)
      .for('update')
      .catch(rethrowQueryFailure);
    if (locked.length !== 1) throw destinationNotFound();
  }
  const [row] = await destinationRecords(db)
    .where(predicate)
    .catch(rethrowQueryFailure);
  if (row === undefined) throw destinationNotFound();
  return Object.freeze(row);
}
