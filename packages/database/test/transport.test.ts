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

  it('retains golden hashes for supported primitive, array, and object roots', () => {
    expect(canonicalOutboxPayloadChecksum({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(canonicalOutboxPayloadChecksum(null)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
    expect(canonicalOutboxPayloadChecksum([1, 2, 3])).toBe(
      'a615eeaee21de5179de080de8c3052c8da901138406ba71c38c032845f7d54f4',
    );
    expect(canonicalOutboxPayloadChecksum({ b: 2, a: { d: 4, c: 3 } })).toBe(
      'c461c47a913352f1a21e3f2ea49e1fd34754c0dc12cb7366e4636d5e186c6c6e',
    );
  });

  it('is stack-safe and bounded for deep, cyclic, and oversized values', () => {
    let deep: unknown = null;
    for (let depth = 0; depth < 5_000; depth += 1) deep = { child: deep };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const payload of [deep, cyclic, { value: 'x'.repeat(4_096) }])
      expect(() => canonicalOutboxPayloadChecksum(payload)).toThrow(TypeError);
  });

  it('counts multibyte bytes exactly at the queue boundary', () => {
    expect(() =>
      canonicalOutboxPayloadChecksum('é'.repeat(2_047)),
    ).not.toThrow();
    expect(() => canonicalOutboxPayloadChecksum('é'.repeat(2_048))).toThrow(
      'outbox payload must not exceed 4096 UTF-8 bytes',
    );
  });

  it('checks PostgreSQL JSONB expansion separately from compact bytes', () => {
    const exponentHeavy = Array.from({ length: 14 }, () => 1e-300);
    expect(
      Buffer.byteLength(JSON.stringify(exponentHeavy), 'utf8'),
    ).toBeLessThan(4096);
    expect(() => canonicalOutboxPayloadChecksum(exponentHeavy)).toThrow(
      'outbox payload exceeds the PostgreSQL JSONB 4096-byte backstop',
    );
  });

  it.each(['\u0000', '\ud800', '\udc00'])(
    'rejects PostgreSQL-incompatible string data',
    (value) => {
      expect(() => canonicalOutboxPayloadChecksum(value)).toThrow(TypeError);
    },
  );

  it('rejects getters and proxies without invoking hooks and permits acyclic aliases', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 1;
      },
    });
    let proxyCalls = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          proxyCalls += 1;
          return [];
        },
      },
    );
    expect(() => canonicalOutboxPayloadChecksum(accessor)).toThrow(TypeError);
    expect(() => canonicalOutboxPayloadChecksum(proxy)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);

    const shared = { value: 1 };
    expect(canonicalOutboxPayloadChecksum([shared, shared])).toBe(
      canonicalOutboxPayloadChecksum([{ value: 1 }, { value: 1 }]),
    );
  });

  it('retains array order as part of the canonical checksum', () => {
    expect(canonicalOutboxPayloadChecksum([1, 2])).not.toBe(
      canonicalOutboxPayloadChecksum([2, 1]),
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
