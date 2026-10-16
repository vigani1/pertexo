import { expect, it } from 'vitest';
import { approvalConfigSchema, approvalOutputSchema } from '../../src/index.js';
it('keeps absent and explicit false starter permission off, requiring an actual boolean', () => {
  expect(approvalConfigSchema.parse({})).not.toHaveProperty(
    'allowStarterToDecide',
  );
  for (const allowed of [false, true])
    expect(
      approvalConfigSchema.parse({ allowStarterToDecide: allowed })
        .allowStarterToDecide,
    ).toBe(allowed);
  expect(
    approvalConfigSchema.safeParse({ allowStarterToDecide: 'true' }).success,
  ).toBe(false);
});
it('reads legacy approval output and bounds the recorded name', () => {
  const legacy = {
    decision: 'approved',
    comment: null,
    decidedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decidedAt: '2026-10-16T00:00:00.000Z',
  };
  expect(approvalOutputSchema.parse(legacy)).toEqual(legacy);
  expect(
    approvalOutputSchema.parse({ ...legacy, decidedByName: 'Approver 🧵' })
      .decidedByName,
  ).toBe('Approver 🧵');
  for (const name of ['x'.repeat(257), 'a\0b', null])
    expect(
      approvalOutputSchema.safeParse({ ...legacy, decidedByName: name })
        .success,
    ).toBe(false);
});
