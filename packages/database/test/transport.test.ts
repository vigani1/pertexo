import { describe, expect, it } from 'vitest';

import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../src/outbox.js';

const checksum = 'a'.repeat(64);

describe('transport persistence input boundary', () => {
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
