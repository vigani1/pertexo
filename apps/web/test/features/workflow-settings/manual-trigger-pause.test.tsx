import type { WorkflowAutoPauseSettings } from '@pertexo/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { unpausedWorkflowSettings } from '../../support/fixtures/auto-pause';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import { installQueries, userId, workflowApi } from './fixtures';
import { path } from './workflow-auto-pause/fixture';

it('pauses and resumes from the workflow state row and shows who paused it in the header', async () => {
  installQueries();
  let settings: WorkflowAutoPauseSettings = unpausedWorkflowSettings;
  const requests: { intent: string; key: string | null; body: unknown }[] = [];
  mockServer.use(
    http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(settings)),
    http.post(`${workflowApi}/:intent`, async ({ request, params }) => {
      requests.push({
        intent: String(params.intent),
        key: request.headers.get('idempotency-key'),
        body: await request.json(),
      });
      settings =
        params.intent === 'pause'
          ? {
              ...settings,
              pauseState: 'paused',
              pauseReason: 'manual',
              pauseRevision: '2',
              pausedAt: '2026-11-28T14:02:00.000000Z',
              pausedBy: { id: userId, displayName: 'Mara' },
            }
          : { ...unpausedWorkflowSettings, pauseRevision: '3' };
      return HttpResponse.json({ settings, replayed: false });
    }),
  );
  await renderLoadedApp(path);
  const controls = within(
    await screen.findByRole('region', { name: 'Workflow state' }),
  );
  const event = userEvent.setup();
  await event.click(
    await controls.findByRole('button', {
      name: 'Pause triggers',
    }),
  );
  const resume = await controls.findByRole('button', {
    name: 'Resume triggers',
  });
  expect(await screen.findByText(/^Paused by Mara · /u)).toBeVisible();
  await event.click(resume);
  expect(
    await controls.findByRole('button', {
      name: 'Pause triggers',
    }),
  ).toBeEnabled();
  expect(screen.queryByText(/^Paused by Mara · /u)).not.toBeInTheDocument();
  expect(requests.map(({ intent, body }) => ({ intent, body }))).toEqual([
    {
      intent: 'pause',
      body: { expectedPauseRevision: '1' },
    },
    {
      intent: 'resume',
      body: { expectedPauseRevision: '2' },
    },
  ]);
  for (const request of requests) expect(request.key).toMatch(/.+/u);
  expect(requests[1]?.key).not.toBe(requests[0]?.key);
});
