import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { DataTablesPage } from '@/features/data-tables/pages/tables';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { fixtureWorkspace } from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';

it('shows read recovery without claiming absence until a successful definitions response establishes it', async () => {
  let failed = true;
  mockServer.use(
    http.get('*/v1/workspaces/:workspaceId/data-tables', () =>
      failed
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json({
            tables: [],
            quotas: {
              tableLimit: 20,
              columnLimit: 20,
              rowLimit: 10000,
              byteLimit: 52428800,
              tableCount: 0,
              storedBytes: 0,
            },
          }),
    ),
  );
  const workspace = fixtureWorkspace(['workspace:read']);
  renderInRouter(
    <DataTablesPage
      scope={{
        apiClient: createApiClient({
          fetch: testFetch,
          readCsrfToken: () => undefined,
        }),
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        workspaceId: workspace.id,
      }}
      workspace={workspace}
      tableId="10000000-0000-4000-8000-000000000001"
      onOpen={() => undefined}
    />,
  );
  const retry = await screen.findByRole('button', { name: 'Retry' });
  expect(
    screen.queryByText(/This table is unavailable/u),
  ).not.toBeInTheDocument();
  failed = false;
  await userEvent.setup().click(retry);
  expect(await screen.findByText(/This table is unavailable/u)).toBeVisible();
});
