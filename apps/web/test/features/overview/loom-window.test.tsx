import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { HomeLoom } from '@/features/overview/components/home-loom';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';
import { fixtureIds, fixtureStatistics } from '../../support/fixtures/run';

it.each(['drawing', 'statistics'] as const)(
  'waits for both selected-window reads when %s arrives first',
  async (first) => {
    let changing = false;
    let releaseDrawing: () => void = () => undefined;
    let releaseStatistics: () => void = () => undefined;
    const drawing = new Promise<void>((resolve) => {
      releaseDrawing = resolve;
    });
    const statistics = new Promise<void>((resolve) => {
      releaseStatistics = resolve;
    });
    mockServer.use(
      http.get('*/v1/workspaces/:workspaceId/runs', async () => {
        if (changing) await drawing;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
      http.get(
        '*/v1/workspaces/:workspaceId/run-statistics',
        async ({ request }) => {
          const next = new URL(request.url).searchParams.get('window') === '7d';
          if (next) await statistics;
          return HttpResponse.json(
            fixtureStatistics({
              window: next ? '7d' : '1h',
              byStatus: { succeeded: next ? 41 : 12 },
              workflows: [],
            }),
          );
        },
      ),
    );
    renderInRouter(
      <HomeLoom
        apiClient={createApiClient({
          fetch: testFetch,
          readCsrfToken: () => undefined,
        })}
        userId={fixtureIds.user}
        workspaceId={fixtureIds.workspace}
      />,
    );
    await screen.findByText('12 runs in the last hour.');
    changing = true;
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: '7 days' }));
    expect(
      screen.queryByText('12 runs in the last 7 days.'),
    ).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      (first === 'drawing' ? releaseDrawing : releaseStatistics)();
    });
    expect(
      screen.queryByText('41 runs in the last 7 days.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: 'Loading recent runs' }),
    ).toBeVisible();
    await act(async () => {
      await Promise.resolve();
      releaseDrawing();
      releaseStatistics();
    });
    expect(
      await screen.findByText('41 runs in the last 7 days.'),
    ).toBeVisible();
  },
);

it('shows and retries a refused exact-statistics read without presenting a successful drawing as a complete window', async () => {
  let failed = true;
  mockServer.use(
    http.get('*/v1/workspaces/:workspaceId/runs', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('*/v1/workspaces/:workspaceId/run-statistics', () =>
      failed
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json(
            fixtureStatistics({
              window: '1h',
              byStatus: { succeeded: 12 },
              workflows: [],
            }),
          ),
    ),
  );
  renderInRouter(
    <HomeLoom
      apiClient={createApiClient({
        fetch: testFetch,
        readCsrfToken: () => undefined,
      })}
      userId={fixtureIds.user}
      workspaceId={fixtureIds.workspace}
    />,
  );
  const retry = await screen.findByRole('button', { name: 'Try again' });
  expect(
    screen.queryByText('12 runs in the last hour.'),
  ).not.toBeInTheDocument();
  failed = false;
  await userEvent.setup().click(retry);
  expect(await screen.findByText('12 runs in the last hour.')).toBeVisible();
});
