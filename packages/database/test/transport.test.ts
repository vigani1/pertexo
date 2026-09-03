import { describe, expect, it } from 'vitest';

import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../src/execution/outbox.js';
import { createOutboxDispatcherDatabase } from '../src/execution/dispatcher.js';
import { parseDatabaseConfig } from '../src/config.js';

const checksum = 'a'.repeat(64);

describe('transport persistence input boundary', () => {
  it('holds all work for an empty allowlist and rejects duplicates before querying PostgreSQL', async () => {
    const dispatcher = createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString:
          'postgresql://dispatcher:secret@127.0.0.1:1/unreachable',
        connectionTimeoutMillis: 1,
        max: 1,
      }),
    );

    await expect(
      dispatcher.claimBatch({
        enabledJobNames: [],
        leaseDurationMillis: 30_000,
        leaseOwner: 'validation-proof',
        leaseToken: '11111111-1111-4111-8111-111111111111',
        limit: 1,
        maxAttempts: 3,
      }),
    ).resolves.toEqual({ events: [], exhaustedCount: 0 });
    await expect(
      dispatcher.observeBacklog({ enabledJobNames: [] }),
    ).resolves.toEqual({ backlog: 0 });
    await expect(
      dispatcher.observeBacklog({
        enabledJobNames: ['advance-workflow-run', 'advance-workflow-run'],
      }),
    ).rejects.toThrow();

    await dispatcher.close();
  });

  it('rejects an outbox payload larger than the 4 KiB queue contract cap', async () => {
    await expect(
      insertOutboxEvent(null as never, {
        id: '11111111-1111-4111-8111-111111111111',
        jobName: 'advance-workflow-run',
        schemaVersion: 1,
        aggregateType: 'workflow-run',
        aggregateId: '22222222-2222-4222-8222-222222222222',
        payload: { value: 'x'.repeat(4_096) },
        payloadChecksum: checksum,
      }),
    ).rejects.toThrow('outbox payload must not exceed 4096 UTF-8 bytes');
  });

  it('rejects malformed payload checksums before accessing a transaction', async () => {
    await expect(
      insertOutboxEvent(null as never, {
        id: '11111111-1111-4111-8111-111111111111',
        jobName: 'advance-workflow-run',
        schemaVersion: 1,
        aggregateType: 'workflow-run',
        aggregateId: '22222222-2222-4222-8222-222222222222',
        payload: {},
        payloadChecksum: 'not-a-checksum',
      }),
    ).rejects.toThrow();
  });

  it('canonicalizes object keys when hashing a payload', () => {
    expect(canonicalOutboxPayloadChecksum({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalOutboxPayloadChecksum({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('rejects a validly formatted checksum that does not match the payload', async () => {
    await expect(
      insertOutboxEvent(null as never, {
        id: '11111111-1111-4111-8111-111111111111',
        jobName: 'advance-workflow-run',
        schemaVersion: 1,
        aggregateType: 'workflow-run',
        aggregateId: '22222222-2222-4222-8222-222222222222',
        payload: { runId: '33333333-3333-4333-8333-333333333333' },
        payloadChecksum: checksum,
      }),
    ).rejects.toThrow(
      'outbox payload checksum does not match its canonical JSON',
    );
  });
});
