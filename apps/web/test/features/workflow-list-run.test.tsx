import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  api,
  discoveryHandlers,
  draftHandler,
  problem,
  secondWorkflowId,
  summary,
  versionId,
  workflowId,
  workspaceId,
} from './workflow-list.fixtures';

function listHandler(pages: (after: string | null) => Record<string, unknown>) {
  return http.get(`${api}/workflows`, ({ request }) =>
    HttpResponse.json(pages(new URL(request.url).searchParams.get('after'))),
  );
}

const startedRunId = '34343434-3434-4343-8343-343434343434';

/** Accepts one run start, recording its key and body. */
function startRunHandler(starts: { key: string | null; body: unknown }[]) {
  return http.post(
    `${api}/workflows/${workflowId}/runs`,
    async ({ request }) => {
      starts.push({
        key: request.headers.get('idempotency-key'),
        body: await request.json(),
      });
      return HttpResponse.json(
        {
          run: {
            id: startedRunId,
            workspaceId,
            workflowId,
            workflowVersionId: versionId,
            status: 'queued',
            triggerType: 'manual',
            createdAt: '2026-09-14T10:00:00.000Z',
            updatedAt: '2026-09-14T10:00:00.000Z',
            startedAt: null,
            completedAt: null,
            deadlineAt: null,
            cancelRequestedAt: null,
          },
          replayed: false,
        },
        { status: 202 },
      );
    },
  );
}

describe('running from the workflow list', () => {
  it('runs a published workflow from its row and opens the new run', async () => {
    const starts: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...discoveryHandlers(['run:start', 'connection:read']),
      draftHandler(),
      listHandler(() => ({
        items: [
          summary(workflowId, 'Daily intake', {
            publishedVersionId: versionId,
            activationStatus: 'active',
          }),
          summary(secondWorkflowId, 'Incident response'),
        ],
        nextCursor: null,
      })),
      startRunHandler(starts),
      http.get(`${api}/runs/${startedRunId}`, () => problem(404, 'not_found')),
    );
    const { router } = renderApp(`/w/${workspaceId}/workflows`);
    const run = await screen.findByRole('button', {
      name: 'Run Daily intake',
    });
    // Drafts have nothing published to run.
    expect(
      screen.queryByRole('button', { name: 'Run Incident response' }),
    ).not.toBeInTheDocument();
    await userEvent.setup().click(run);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${startedRunId}`,
      );
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
    expect(starts[0]?.body).toEqual({ input: {} });
  });

  it('runs the focused row with R and offers Run in its menu', async () => {
    const starts: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...discoveryHandlers(['run:start', 'connection:read']),
      draftHandler(),
      listHandler(() => ({
        items: [
          summary(workflowId, 'Daily intake', {
            publishedVersionId: versionId,
            activationStatus: 'active',
          }),
        ],
        nextCursor: null,
      })),
      startRunHandler(starts),
      http.get(`${api}/runs/${startedRunId}`, () => problem(404, 'not_found')),
    );
    const { router } = renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Actions for Daily intake' }),
    );
    expect(
      await screen.findByRole('menuitem', { name: /^Run/u }),
    ).toBeVisible();
    await event.keyboard('{Escape}');
    screen.getByRole('link', { name: 'Daily intake' }).focus();
    await event.keyboard('r');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${startedRunId}`,
      );
    });
    expect(starts).toHaveLength(1);
  });

  it('offers no Run to people who can’t start runs', async () => {
    mockServer.use(
      ...discoveryHandlers(['connection:read']),
      draftHandler(),
      listHandler(() => ({
        items: [
          summary(workflowId, 'Daily intake', {
            publishedVersionId: versionId,
            activationStatus: 'active',
          }),
        ],
        nextCursor: null,
      })),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(await screen.findByText('Daily intake')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Run Daily intake' }),
    ).not.toBeInTheDocument();
  });
});
