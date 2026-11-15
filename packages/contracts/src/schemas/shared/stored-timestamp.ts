import { STORED_TIMESTAMP_FRACTION_DIGITS } from '@pertexo/workflow-model';
import { z } from 'zod';

/** A stored timestamp as the API writes it: UTC, with every fraction digit. */
export const storedTimestampSchema = z.iso.datetime({
  precision: STORED_TIMESTAMP_FRACTION_DIGITS,
});
