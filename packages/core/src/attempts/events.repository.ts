import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { databaseSchema } from '@pertexo/database/schema';
import {
  parseWorkspaceId,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  appendLockedRunEvent,
  type RunEventType,
} from '../runs/queries/history/events.repository.js';

/** Adapt the attempt transaction's client to the shared locked-run event writer. */
export function appendAttemptEvent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    type: RunEventType;
    payload: unknown;
  }>,
): Promise<number> {
  return appendLockedRunEvent(
    {
      db: drizzle(client, { schema: databaseSchema }),
      workspaceId: parseWorkspaceId(input.workspaceId),
    },
    input.runId,
    { type: input.type, payload: input.payload },
  ).catch(rethrowQueryFailure);
}
