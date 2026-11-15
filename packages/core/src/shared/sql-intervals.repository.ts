import { sql } from 'drizzle-orm';

/** The unit a stored millisecond count multiplies into an interval. */
export const MILLISECOND_INTERVAL = sql.raw("interval '1 millisecond'");

/** The unit a stored second count multiplies into an interval. */
export const SECOND_INTERVAL = sql.raw("interval '1 second'");
