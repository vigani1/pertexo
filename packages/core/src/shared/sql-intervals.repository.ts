import { sql } from 'drizzle-orm';

// A fixed or stored duration is always a count times one of these units
// (`${DAYS}*${DAY_INTERVAL}`), never a literal like interval '30 days'.

/** The unit a stored millisecond count multiplies into an interval. */
export const MILLISECOND_INTERVAL = sql.raw("interval '1 millisecond'");

/** The unit a stored second count multiplies into an interval. */
export const SECOND_INTERVAL = sql.raw("interval '1 second'");

/** The unit a minute count multiplies into an interval. */
export const MINUTE_INTERVAL = sql.raw("interval '1 minute'");

/** The unit an hour count multiplies into an interval. */
export const HOUR_INTERVAL = sql.raw("interval '1 hour'");

/** The unit a day count multiplies into an interval (a calendar day). */
export const DAY_INTERVAL = sql.raw("interval '1 day'");
