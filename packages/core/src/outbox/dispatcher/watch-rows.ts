import { setTimeout as delay } from 'node:timers/promises';

import { createDedicatedClient } from '@pertexo/database/primitives';
import type { Pool } from 'pg';

/** A trigger on `outbox_events` signals this after every statement that adds rows. */
const OUTBOX_ROWS_CHANNEL = 'outbox_rows';
const RELISTEN_MILLIS = 5_000;

/**
 * Calls `onRows` when rows may be ready, until `signal` ends it. This is only a
 * hint that saves a poll: the dispatcher's own poll still finds everything, so a lost
 * connection is retried quietly and nothing here can fail a delivery.
 */
export async function watchForOutboxRows(
  pool: Pool,
  onRows: () => void,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await listenUntilLost(pool, onRows, signal).catch(() => undefined);
    await delay(RELISTEN_MILLIS, undefined, { signal }).catch(() => undefined);
  }
}

/**
 * On a connection of its own. The dispatcher's pool is small and its work needs it:
 * holding one here would slow every publication, or stop them on a pool of one.
 */
async function listenUntilLost(
  pool: Pool,
  onRows: () => void,
  signal: AbortSignal,
): Promise<void> {
  const client = createDedicatedClient(pool);
  const lost = Promise.withResolvers<undefined>();
  const onLost = (): void => {
    lost.resolve(undefined);
  };
  client.on('notification', onRows);
  client.on('error', onLost);
  client.on('end', onLost);
  signal.addEventListener('abort', onLost, { once: true });
  try {
    if (signal.aborted) return;
    await client.connect();
    await client.query(`listen ${OUTBOX_ROWS_CHANNEL}`);
    // Rows written before the listen took effect signalled nobody.
    onRows();
    await lost.promise;
  } finally {
    signal.removeEventListener('abort', onLost);
    await client.end().catch(() => undefined);
  }
}
