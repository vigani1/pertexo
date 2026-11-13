import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import type { DataTableDefinition } from '@pertexo/contracts';
import { DataTableRows } from '@/features/data-tables/components/rows/table-rows';
import { DataTablesPage } from '@/features/data-tables/pages/tables';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { fixtureWorkspace } from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';

const userId = '01900000-0000-7000-8000-000000000004';
const table: DataTableDefinition = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Private orders',
  revision: 1,
  keyColumn: 'reference',
  hasRemovedColumns: false,
  storedBytes: 1024,
  rowCount: 1,
  columns: [
    { id: 'reference', name: 'reference', type: 'text', required: true },
  ],
};
const quotas = {
  tableLimit: 20,
  columnLimit: 20,
  rowLimit: 10000,
  byteLimit: 52428800,
  tableCount: 1,
  storedBytes: 1024,
};

it('removes a table’s definition from the page once a refresh is forbidden', async () => {
  let denied = false;
  mockServer.use(
    http.get('*/v1/workspaces/:workspaceId/data-tables', () =>
      denied ? forbidden() : HttpResponse.json({ tables: [table], quotas }),
    ),
    http.post(
      '*/v1/workspaces/:workspaceId/data-tables/:tableId/rows/query',
      () => HttpResponse.json({ rows: [], affected: 0, hasMore: false }),
    ),
  );
  const workspace = fixtureWorkspace(['workspace:read']);
  const { queryClient } = renderInRouter(
    <DataTablesPage
      scope={{ apiClient: client(), userId, workspaceId: workspace.id }}
      workspace={workspace}
      tableId={table.id}
      onOpen={() => undefined}
    />,
  );
  expect(
    await screen.findByRole('heading', { name: 'Private orders' }),
  ).toBeVisible();

  denied = true;
  await act(async () => {
    await queryClient.refetchQueries();
  });

  expect(
    (await screen.findAllByRole('button', { name: 'Retry' })).length,
  ).toBeGreaterThan(0);
  expect(
    screen.queryByRole('heading', { name: 'Private orders' }),
  ).not.toBeInTheDocument();
});

it.each([
  [403, false],
  [503, true],
] as const)(
  'after a %s refresh, earlier rows stay on screen only when access remains',
  async (status, kept) => {
    let failing = false;
    mockServer.use(
      http.post(
        '*/v1/workspaces/:workspaceId/data-tables/:tableId/rows/query',
        () =>
          failing
            ? refusal(status)
            : HttpResponse.json({
                rows: [
                  {
                    id: '01900000-0000-7000-8000-000000000010',
                    revision: 1,
                    values: { reference: 'Item 1' },
                  },
                ],
                affected: 0,
                hasMore: false,
              }),
      ),
    );
    const { queryClient } = renderInRouter(
      <DataTableRows
        scope={{
          apiClient: client(),
          userId,
          workspaceId: '01900000-0000-7000-8000-000000000002',
        }}
        table={table}
        editable={false}
      />,
    );
    expect(await screen.findByText('Item 1')).toBeVisible();

    failing = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });

    expect(await screen.findByRole('button', { name: /Retry/u })).toBeVisible();
    if (kept) expect(screen.getByText('Item 1')).toBeVisible();
    else expect(screen.queryByText('Item 1')).not.toBeInTheDocument();
  },
);

it.each([
  // An ended session keeps the edit: the session pause hides the page and
  // keeps it for the same person signing in again.
  [401, true],
  [403, false],
  [404, false],
  [503, true],
] as const)(
  'after a %s refresh, an open row editor keeps the row unless access is gone',
  async (status, kept) => {
    let failing = false;
    mockServer.use(
      http.post(
        '*/v1/workspaces/:workspaceId/data-tables/:tableId/rows/query',
        () =>
          failing
            ? problem(status, refusalCode(status), 'Refused')
            : HttpResponse.json({
                rows: [
                  {
                    id: '01900000-0000-7000-8000-000000000010',
                    revision: 1,
                    values: { reference: 'Item 1' },
                  },
                ],
                affected: 0,
                hasMore: false,
              }),
      ),
    );
    const { queryClient } = renderInRouter(
      <DataTableRows
        scope={{
          apiClient: client(),
          userId,
          workspaceId: '01900000-0000-7000-8000-000000000002',
        }}
        table={table}
        editable
      />,
    );
    expect(await screen.findByText('Item 1')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /^Edit$/u }));
    expect(await screen.findByDisplayValue('Item 1')).toBeVisible();

    failing = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });

    if (kept)
      await waitFor(() => {
        expect(screen.getByDisplayValue('Item 1')).toBeVisible();
      });
    else
      await waitFor(() => {
        expect(screen.queryByDisplayValue('Item 1')).not.toBeInTheDocument();
      });
  },
);

function refusalCode(status: 401 | 403 | 404 | 503) {
  if (status === 401) return 'auth.unauthenticated';
  if (status === 403) return 'auth.forbidden';
  if (status === 404) return 'resource.not_found';
  return 'internal.unexpected';
}

function client() {
  return createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'data-table-component-csrf',
  });
}

function refusal(status: 403 | 503) {
  return status === 403 ? forbidden() : unavailable();
}

function forbidden() {
  return problem(403, 'auth.forbidden', 'Forbidden');
}

function unavailable() {
  return problem(503, 'internal.unexpected', 'Service unavailable');
}

function problem(status: number, code: string, title: string) {
  return HttpResponse.json(
    {
      type: `urn:pertexo:problem:${code}`,
      title,
      status,
      code,
      requestId: `data-table-${String(status)}`,
    },
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );
}
