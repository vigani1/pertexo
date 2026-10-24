import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { canonicalOutboxPayloadChecksum } from '../../../src/outbox/events.repository.js';

import { createTransportTestEnvironment } from '../transport.support.js';

export const transport = createTransportTestEnvironment();

export const {
  apiDatabase,
  apiUrl,
  checksumA,
  checksumB,
  dispatcher,
  dispatcherUrl,
  hasPostgresCode,
  migrationUrl,
  operator,
  operatorReplica,
  workspaceA,
  workspaceB,
} = transport;

export const enabledJobNames = Object.freeze(['phase0-duplicate-proof']);

export async function expireLease(id: string): Promise<void> {
  const pool = new Pool({ connectionString: dispatcherUrl, max: 1 });
  try {
    await pool.query(
      `update app.outbox_events set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
      [id],
    );
  } finally {
    await pool.end();
  }
}

export function outboxInput(id: string = randomUUID()) {
  const payload = { probeId: randomUUID() };
  return {
    id,
    jobName: 'phase0-duplicate-proof',
    aggregateType: 'queue-proof',
    aggregateId: randomUUID(),
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  } as const;
}
