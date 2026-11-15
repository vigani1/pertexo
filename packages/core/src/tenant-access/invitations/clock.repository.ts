import type { PoolClient } from 'pg';

/** Sample after the flow's lock waits, so an expired capability cannot gain time. */
export async function readInvitationTime(client: PoolClient): Promise<Date> {
  const {
    rows: [clock],
  } = await client.query<{ now: Date }>('select clock_timestamp() as now');
  if (clock === undefined) throw new Error('Database time unavailable');
  return clock.now;
}
