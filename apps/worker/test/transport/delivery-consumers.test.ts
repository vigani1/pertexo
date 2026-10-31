import { DELIVERY_CONSUMER } from '@pertexo/database/outbox';
import { JOB_NAME } from '@pertexo/queue';
import { expect, it } from 'vitest';

// A job kind nobody confirms would be delivered again for a day, then fail.
it('names who confirms every job kind', () => {
  expect(Object.keys(DELIVERY_CONSUMER).sort()).toEqual(
    Object.values(JOB_NAME).sort(),
  );
});
