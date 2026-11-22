import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import {
  CONNECTION_LOOKUP_FIELD,
  connectionLookupPath,
} from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { createApiClient } from '@/lib/api/client';
import { testFetch } from '../../../support/render-app';
import { deferred } from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { choose, saved } from './schema-setup-actions';
import { Fields } from './schema-setup.fixture';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const path = connectionLookupPath(workspaceId, connectionId);
const attached = { type: 'object', properties: { columns: { type: 'array' } } };
const schema = {
  type: 'object',
  properties: {
    selection: {
      type: 'string',
      title: 'Sheet',
      [CONNECTION_LOOKUP_FIELD]: {
        providerKey: 'spreadsheet',
        lookup: 'sheets',
        slot: 'spreadsheet',
        attachTo: 'inputSchema',
      },
    },
    inputSchema: { type: 'object' },
  },
};

function renderLookup() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Fields
        schema={schema}
        lookup={{
          scope: {
            apiClient: createApiClient({
              fetch: testFetch,
              readCsrfToken: () => 'csrf-token-for-component-tests-1234567890',
            }),
            userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceId,
            enabled: true,
          },
          connectionRefs: { spreadsheet: connectionId },
        }}
      />
    </QueryClientProvider>,
  );
}

it('loads choices and saves a selection and attachment together', async () => {
  const reply = deferred<undefined>();
  mockServer.use(
    http.post(`*${path}`, async ({ request }) => {
      expect(await request.json()).toEqual({
        providerKey: 'spreadsheet',
        lookup: 'sheets',
      });
      await reply.promise;
      return HttpResponse.json({
        items: [{ value: 'stored-id', label: 'January', attach: attached }],
      });
    }),
  );
  renderLookup();
  expect(screen.getByText('Loading options…')).toBeVisible();
  reply.resolve(undefined);
  await waitFor(() => {
    expect(screen.queryByText('Loading options…')).toBeNull();
  });
  await choose('Sheet', 'January');
  expect(saved()).toEqual({ selection: 'stored-id', inputSchema: attached });
});

it.each([
  {
    response: () => HttpResponse.json({ items: [] }),
    message: 'No options are available.',
  },
  {
    response: () =>
      HttpResponse.json({ code: 'provider.unavailable' }, { status: 503 }),
    message: 'Could not load options.',
  },
])('shows the lookup status $message', async ({ response, message }) => {
  mockServer.use(http.post(`*${path}`, response));
  renderLookup();
  expect(await screen.findByText(message)).toBeVisible();
  expect(saved()).toEqual({});
});
