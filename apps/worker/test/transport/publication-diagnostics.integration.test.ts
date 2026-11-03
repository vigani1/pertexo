import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { JOB_NAME } from '@pertexo/queue';
import { OutboxDispatcher } from '../../src/transport/outbox/dispatch/outbox-dispatcher.runtime.js';
import { WorkerDrainState } from '../../src/runtime/shutdown/drain-state.js';
import { transportMetrics } from '../support/transport/metrics.js';
import { boundaries } from './outbox-dispatcher/fixture.js';
import {
  describeIntegration,
  prepareWorkerPostgreSQLRedisTransportProofFixture,
  closeWorkerPostgreSQLRedisTransportProofFixture,
  apiDatabase,
  dispatcherUrl,
  workspaceId,
} from './dispatch/fixture.js';

describeIntegration('Permanent publication diagnostics', () => {
  beforeAll(prepareWorkerPostgreSQLRedisTransportProofFixture);
  afterAll(closeWorkerPostgreSQLRedisTransportProofFixture);
  it('keeps a safe field-specific refusal in operator logs without leaking the immutable payload', async () => {
    const id = randomUUID();
    const secret = 'secret-value-that-must-not-reach-logs';
    const payload = { invitationId: secret, deliveryAttemptId: randomUUID() };
    await apiDatabase.withWorkspace(workspaceId, (transaction) =>
      insertOutboxEvent(transaction, {
        id,
        aggregateType: 'workspace-invitation',
        aggregateId: randomUUID(),
        jobName: JOB_NAME.deliverWorkspaceInvitation,
        payload,
        payloadChecksum: canonicalOutboxPayloadChecksum(payload),
        availableAt: new Date(0),
      }),
    );
    const database = createOutboxDispatcherDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
    );
    const producer = boundaries([]).producer;
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };
    const dispatcher = new OutboxDispatcher(database, producer, {
      drainState: new WorkerDrainState(),
      logger,
      metrics: transportMetrics(),
      options: {
        batchSize: 10,
        jobNames: [JOB_NAME.deliverWorkspaceInvitation],
        leaseDurationMillis: 30_000,
        leaseOwner: 'diagnostic-proof',
        retryDelayMillis: 1_000,
      },
    });
    const pool = new Pool({ connectionString: dispatcherUrl, max: 1 });
    try {
      expect(await dispatcher.dispatchOnce()).toMatchObject({
        failed: 1,
        published: 0,
      });
      const result = await pool.query(
        'select failed_at is not null as failed,last_error_code from app.outbox_events where id=$1',
        [id],
      );
      expect(result.rows).toEqual([
        { failed: true, last_error_code: 'outbox.invalid_contract' },
      ]);
      expect(logger.error.mock.calls).toEqual([
        [
          'outbox.publication_refused',
          expect.objectContaining({
            eventId: id,
            workspaceId,
            jobName: JOB_NAME.deliverWorkspaceInvitation,
            errorCode: 'outbox.invalid_contract',
            validationIssues: [
              { field: 'invitationId', code: 'invalid_format' },
            ],
          }),
        ],
      ]);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
      expect(producer.publish).not.toHaveBeenCalled();
    } finally {
      await pool.end();
      await dispatcher.close();
    }
  });
});
