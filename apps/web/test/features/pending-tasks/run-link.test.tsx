import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import {
  apiBase,
  fixtureRun,
  statisticsHandler,
} from '../../support/fixtures/run';
import {
  identityHandlers,
  ownerWorkspace,
  workspaceId,
} from '../../support/fixtures/team';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import { base, detail, summary, taskId } from './fixtures';

it('opens a run request with the default waiting list and a clean URL', async () => {
  const task = detail();
  mockServer.use(
    ...identityHandlers(ownerWorkspace),
    statisticsHandler(),
    http.get(`${apiBase}/runs/${task.runId}`, () =>
      HttpResponse.json({
        run: fixtureRun(task.runId, 'waiting', {
          workflowId: task.workflowId,
          hasHumanTasks: true,
        }),
        nodes: [],
      }),
    ),
    http.get(
      `${apiBase}/runs/${task.runId}/events`,
      () =>
        new HttpResponse('', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
    http.get(base, ({ request }) => {
      const query = new URL(request.url).searchParams;
      const mine =
        query.get('view') === 'mine' && query.get('status') === 'pending';
      const items =
        mine || query.get('runId') === task.runId ? [summary()] : [];
      return HttpResponse.json({
        items,
        nextCursor: null,
        pendingCount: items.length,
      });
    }),
    http.get(`${base}/${taskId}`, () => HttpResponse.json({ task })),
  );
  await renderLoadedApp(`/w/${workspaceId}/runs/${task.runId}`);
  const link = await screen.findByRole('link', { name: task.title });
  expect(link).toHaveAttribute('href', `/w/${workspaceId}/requests/${taskId}`);
  await userEvent.click(link);
  expect(
    await screen.findByRole('heading', { level: 1, name: task.title }),
  ).toBeVisible();
  const list = await screen.findByRole('list', { name: 'Requests' });
  expect(within(list).getByRole('link', { name: task.title })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
