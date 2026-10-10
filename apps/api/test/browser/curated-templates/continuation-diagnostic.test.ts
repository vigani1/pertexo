import { expect, it } from 'vitest';
import { curatedContinuationDiagnosticSchema } from './continuation-diagnostic.js';

const diagnostic = {
  checkpointRevision: 3,
  coordinatorOutbox: 4,
  publishedOutbox: 4,
  failedOutbox: 0,
  completedReceipts: 3,
  incompleteReceipts: 1,
};
it('accepts only bounded durable revision and queue/receipt counts', () => {
  expect(curatedContinuationDiagnosticSchema.parse(diagnostic)).toEqual(
    diagnostic,
  );
  expect(
    curatedContinuationDiagnosticSchema.safeParse({
      ...diagnostic,
      checkpointRevision: null,
    }).success,
  ).toBe(true);
});
it.each([
  { ...diagnostic, payload: 'private' },
  { ...diagnostic, checkpointRevision: -1 },
  { ...diagnostic, coordinatorOutbox: 100001 },
  { ...diagnostic, completedReceipts: 'private' },
])('rejects raw or unbounded diagnostic data', (value) => {
  expect(curatedContinuationDiagnosticSchema.safeParse(value).success).toBe(
    false,
  );
});
