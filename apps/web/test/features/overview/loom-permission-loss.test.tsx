import { act, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { HomeLoom } from '@/features/overview/components/home-loom';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';
import { fixtureIds, fixtureStatistics } from '../../support/fixtures/run';

it('hides previously read totals when refreshing exact statistics loses permission', async () => {
  let denied = false;
  mockServer.use(
    http.get('*/v1/workspaces/:workspaceId/runs', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('*/v1/workspaces/:workspaceId/run-statistics', () =>
      denied
        ? HttpResponse.json(
            {
              type: 'urn:pertexo:problem:auth.forbidden',
              title: 'Forbidden',
              status: 403,
              code: 'auth.forbidden',
              requestId: 'loom-permission-refusal',
            },
            {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            },
          )
        : HttpResponse.json(
            fixtureStatistics({
              window: '1h',
              byStatus: { succeeded: 12 },
              workflows: [],
            }),
          ),
    ),
  );
  const { queryClient } = renderInRouter(
    <HomeLoom
      apiClient={createApiClient({
        fetch: testFetch,
        readCsrfToken: () => undefined,
      })}
      userId={fixtureIds.user}
      workspaceId={fixtureIds.workspace}
    />,
  );
  expect(await screen.findByText('12 runs in the last hour.')).toBeVisible();
  denied = true;
  await act(async () => {
    await queryClient.refetchQueries({ type: 'active' });
  });
  expect(
    await screen.findByText(
      'Your role no longer has access to recent runs here.',
    ),
  ).toBeVisible();
  expect(
    screen.queryByText('12 runs in the last hour.'),
  ).not.toBeInTheDocument();
});
