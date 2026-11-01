import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { idempotencyRecords as records } from '@pertexo/database/schema';

import type { AbandonConnectionTestInput } from '../contract.js';
import { withConnectionTransaction } from '../transaction.js';
import { connectionTestClaimRow } from './claim.queries.js';

/** Owning the claim is the authority: losing access mid-test must still release it. */
export async function abandonConnectionTest(
  pool: Pool,
  input: AbandonConnectionTestInput,
): Promise<void> {
  const { stillClaimed } = connectionTestClaimRow(input);
  await withConnectionTransaction(pool, input, async (client) => {
    await drizzle(client)
      .update(records)
      .set({
        status: 'failed',
        resultRef: { state: 'failed' },
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(stillClaimed)
      .catch(rethrowQueryFailure);
  }).catch(rethrowQueryFailure);
}
