import { expect, it } from 'vitest';

import { acceptPreviewRun } from '../../../src/previews/runs/acceptance.repository.js';
import { PreviewAdmissionDeniedError } from '../../../src/previews/errors.js';

import { workspaceA, apiDatabase, input } from './fixture.js';

// Previews are kept at most seven days and execute for at most five minutes.
const minute = 60 * 1_000;
const sevenDays = 7 * 24 * 60 * minute;
const fiveMinutes = 5 * minute;

export function registerBoundsRetentionExecutionDeadline(): void {
  it.each([
    {
      case: 'an expiry in the past',
      expiresAt: -minute,
      executionDeadlineAt: -2 * minute,
      reason: 'retention',
    },
    {
      case: 'an expiry beyond seven days',
      expiresAt: sevenDays + minute,
      executionDeadlineAt: minute,
      reason: 'retention',
    },
    {
      case: 'a deadline in the past',
      expiresAt: minute,
      executionDeadlineAt: -minute,
      reason: 'deadline',
    },
    {
      case: 'a deadline beyond five minutes',
      expiresAt: 60 * minute,
      executionDeadlineAt: fiveMinutes + minute,
      reason: 'deadline',
    },
    {
      case: 'a deadline after the expiry',
      expiresAt: 2 * minute,
      executionDeadlineAt: 3 * minute,
      reason: 'deadline',
    },
  ] as const)(
    'refuses $case',
    async ({ expiresAt, executionDeadlineAt, reason }) => {
      const now = Date.now();

      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptPreviewRun(
            transaction,
            input({
              expiresAt: new Date(now + expiresAt),
              executionDeadlineAt: new Date(now + executionDeadlineAt),
            }),
          ),
        ),
      ).rejects.toStrictEqual(new PreviewAdmissionDeniedError(reason));
    },
  );

  it('accepts an expiry and a deadline just inside both maxima', async () => {
    const now = Date.now();

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(
          transaction,
          input({
            expiresAt: new Date(now + sevenDays - minute),
            executionDeadlineAt: new Date(now + fiveMinutes - 10_000),
          }),
        ),
      ),
    ).resolves.toMatchObject({ previewRunId: expect.any(String) });
  });
}
