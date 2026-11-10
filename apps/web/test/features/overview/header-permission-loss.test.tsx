import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import {
  coldStart,
  fixtureStatistics,
  identityHandlers,
} from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  readerCapabilities,
  runHandlers,
  workflowHandlers,
  workspaceId,
} from './page/fixture';

it('removes Home header counts after the statistics refresh authoritatively loses access', async () => {
  let denied = false;
  mockServer.use(
    ...identityHandlers(readerCapabilities),
    workflowHandlers([]),
    ...runHandlers({ problems: [] }),
  );
  mockServer.use(
    http.get('*/v1/workspaces/:workspaceId/run-statistics', ({ request }) =>
      denied
        ? HttpResponse.json(
            {
              type: 'urn:pertexo:problem:auth.forbidden',
              title: 'Forbidden',
              status: 403,
              code: 'auth.forbidden',
              requestId: 'home-header-access-lost',
            },
            {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            },
          )
        : HttpResponse.json(
            fixtureStatistics({
              window: new URL(request.url).searchParams.get('window') ?? '24h',
              current: { running: 142 },
              byStatus: { failed: 118 },
              workflows: [],
            }),
          ),
    ),
  );
  await renderLoadedApp(`/w/${workspaceId}`);
  expect(
    await screen.findByText('118', { selector: 'b' }, coldStart),
  ).toBeVisible();
  denied = true;
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Refresh' }));
  expect(
    await screen.findByText(
      'Your role no longer has access to recent runs here.',
    ),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled(),
  );
  expect(screen.queryByText('118', { selector: 'b' })).not.toBeInTheDocument();
});
