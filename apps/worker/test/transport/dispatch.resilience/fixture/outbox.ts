import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  createWorkspaceDatabase,
  insertOutboxEvent,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import type { QueueProducer } from '@pertexo/queue';

import { expect } from 'vitest';

import type { WorkerDrainState } from '../../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../../src/transport/outbox/dispatch/runtime.js';

import { localApiUrl, localDispatcherUrl, redisUrl } from './environment.js';
import type { OutboxProofState } from './contract.js';
import { dispatcherPool } from './database.js';

export async function insertProofEvent(
  workspaceId: string,
  id: string,
): Promise<void> {
  const database = createWorkspaceDatabase(
    parseDatabaseConfig({
      connectionString: localApiUrl.toString(),
      connectionTimeoutMillis: 1_000,
      max: 1,
    }),
  );
  const notificationIntentId = randomUUID();
  const payload = { notificationIntentId };
  try {
    await database.withWorkspace(workspaceId, async (transaction) => {
      await insertOutboxEvent(transaction, {
        aggregateId: notificationIntentId,
        aggregateType: 'run-failure-notification',
        // The dispatcher is intentionally cross-workspace, but this disposable
        // database contains only proof-owned rows.
        availableAt: new Date('1900-01-01T00:00:00.000Z'),
        id,
        jobName: JOB_NAME.deliverRunFailureNotification,
        payload,
        payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      });
    });
  } finally {
    await database.close();
  }
}

export async function outboxState(id: string): Promise<OutboxProofState> {
  const pool = dispatcherPool();
  try {
    const result = await pool.query<OutboxProofState>(
      `
        select
          failed_at,
          last_error_code,
          lease_expires_at,
          lease_owner,
          publish_attempts,
          published_at
        from app.outbox_events
        where id = $1
      `,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Missing proof outbox event ${id}`);
    }
    return row;
  } finally {
    await pool.end();
  }
}

export async function assertCleanOutbox(workspaceId: string): Promise<void> {
  const pool = dispatcherPool();
  try {
    const result = await pool.query<{ pending: number }>(
      `
        select count(*)::integer as pending
        from app.outbox_events
        where workspace_id = $1
          and published_at is null
          and failed_at is null
      `,
      [workspaceId],
    );
    expect(result.rows[0]).toEqual({ pending: 0 });
  } finally {
    await pool.end();
  }
}

export function createDispatcher(
  drainState: WorkerDrainState,
  leaseOwner: string,
): Readonly<{
  database: ReturnType<typeof createOutboxDispatcherDatabase>;
  dispatcher: OutboxDispatcher;
  producer: QueueProducer;
}> {
  const database = createOutboxDispatcherDatabase(
    parseDatabaseConfig({
      connectionString: localDispatcherUrl.toString(),
      connectionTimeoutMillis: 500,
      max: 1,
    }),
  );
  const producer = createQueueProducer({
    publishTimeoutMs: 500,
    readyTimeoutMs: 500,
    redisUrl,
  });
  return {
    database,
    dispatcher: new OutboxDispatcher(database, producer, {
      drainState: drainState,
      options: {
        batchSize: 100,
        jobNames: [JOB_NAME.deliverRunFailureNotification],
        leaseDurationMillis: 1_000,
        leaseOwner,
        operationTimeoutMillis: 1_000,
        pollIntervalMillis: 25,
        retryDelayMillis: 100,
      },
    }),
    producer,
  };
}
