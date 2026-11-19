import { expect, test } from '../support/fixtures';
import { expectSpoken, startScreenReader } from '../support/screen-reader';
import {
  firstRunId,
  installRoutes,
  run,
  workspaceId,
} from '../run-history/fixture';

test('a screen-reader user hears a run finish and reads its result', async ({
  page,
}) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installRoutes(page);
  let finished = false;
  const node = (status: string) => ({
    id: '22222222-2222-4222-8222-222222222222',
    nodeId: 'send',
    invocationKey: 'send:1',
    status,
    currentAttemptNumber: 1,
    startedAt: '2026-09-15T10:00:00.000Z',
    completedAt: status === 'running' ? null : '2026-09-15T10:00:02.000Z',
    resumeAt: null,
    safeErrorCode: null,
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
    (route) =>
      route.fulfill({
        json: finished
          ? { run: run(firstRunId, 'succeeded'), nodes: [node('succeeded')] }
          : {
              run: {
                ...run(firstRunId, 'succeeded'),
                status: 'running',
                completedAt: null,
              },
              nodes: [node('running')],
            },
      }),
  );
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await startScreenReader(page);
  finished = true;

  // The finish is said where the user is, without hunting for the title.
  await expectSpoken(page, /^polite: Succeeded in 2s$/u);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Succeeded in 2s' }),
  ).toBeVisible();

  // The result reads as a named list of steps, each with its outcome, and
  // choosing one by keyboard opens its details.
  const steps = page.getByRole('list', { name: 'Steps in this run' });
  const step = steps.getByRole('button', { name: 'send: Succeeded, 2s' });
  await step.focus();
  await expectSpoken(page, /^button, send: Succeeded, 2s/u);
  await page.keyboard.press('Enter');
  await expect(step).toHaveAttribute('aria-pressed', 'true');
  const details = page.getByRole('complementary', { name: 'Step details' });
  await expect(details.getByRole('heading', { name: 'send' })).toBeVisible();
  await expect(details.getByText('Attempt 1 succeeded')).toBeVisible();
});
