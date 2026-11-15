import { z } from 'zod';

/** PostgreSQL keeps timestamps to the microsecond: six fraction digits. */
export const STORED_TIMESTAMP_FRACTION_DIGITS = 6;

/** A stored timestamp as the API writes it: UTC, with every fraction digit. */
export const storedTimestampSchema = z.iso.datetime({
  precision: STORED_TIMESTAMP_FRACTION_DIGITS,
});
