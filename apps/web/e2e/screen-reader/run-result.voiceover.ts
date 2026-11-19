import { voiceOverTest as test } from '@guidepup/playwright';
import { expect } from '@playwright/test';
import {
  firstRunId,
  installRoutes,
  run,
  workspaceId,
} from '../run-history/fixture';

test('VoiceOver says a run finished and reads its steps', async ({
  page,
  voiceOver,
}) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installRoutes(page);
  let finished = false;
  const step = (status: string) => ({
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
          ? { run: run(firstRunId, 'succeeded'), nodes: [step('succeeded')] }
          : {
              run: {
                ...run(firstRunId, 'succeeded'),
                status: 'running',
                completedAt: null,
              },
              nodes: [step('running')],
            },
      }),
  );
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`, {
    waitUntil: 'load',
  });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await voiceOver.navigateToWebContent();

  // The finish is spoken without moving: the page's status region says the
  // run's result once the page learns of it.
  finished = true;
  await expect(
    page.getByRole('heading', { level: 1, name: 'Succeeded in 2s' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        `${(await voiceOver.spokenPhraseLog()).join(' | ')} | ${await voiceOver.lastSpokenPhrase()}`,
    )
    .toMatch(/Succeeded in 2s/u);

  // The step list reads each step with its outcome.
  await page
    .getByRole('list', { name: 'Steps in this run' })
    .getByRole('button')
    .first()
    .focus();
  await expect
    .poll(() => voiceOver.lastSpokenPhrase())
    .toMatch(/send: Succeeded, 2s/u);
});
