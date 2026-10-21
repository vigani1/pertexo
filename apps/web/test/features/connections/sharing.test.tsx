import { useConnectionSharingEditor } from '@/features/connections/hooks/use-sharing-editor';
import { discoveryHandlers } from '../workflows/list/fixtures';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import type { ConnectionSharing } from '@pertexo/contracts';
import { ConnectionSharingPanel } from '@/features/connections/components/sharing/panel';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  connectionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;
function setup() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-1234567890',
  });
  let current: ConnectionSharing = {
    connectionId,
    mode: 'workspace',
    revision: 1,
    members: [],
  };
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/connections/${connectionId}/sharing`, () =>
      HttpResponse.json(current),
    ),
    http.get(`${api}/resource-sharing-principals`, () =>
      HttpResponse.json({
        items: [{ kind: 'member', userId, label: 'Jane' }],
        next: null,
      }),
    ),
  );
  function SharingHarness() {
    const scope = { apiClient, userId, workspaceId };
    const editor = useConnectionSharingEditor(scope, connectionId);
    return <ConnectionSharingPanel scope={scope} editor={editor} />;
  }
  render(
    <QueryClientProvider client={cache}>
      <SharingHarness />
    </QueryClientProvider>,
  );
  return {
    cache,
    update: (next: ConnectionSharing) => {
      current = next;
    },
  };
}
it('uses selected members, explains the role ceiling, and sends only Use grants with the current sharing revision', async () => {
  const saved: unknown[] = [];
  const f = setup();
  mockServer.use(
    http.post(
      `${api}/connections/${connectionId}/sharing`,
      async ({ request }) => {
        const body: unknown = await request.json();
        saved.push(body);
        const result: ConnectionSharing = {
          connectionId,
          mode: 'restricted',
          revision: 2,
          members: [{ userId, label: 'Jane', active: true }],
        };
        f.update(result);
        return HttpResponse.json({ ...result, replayed: false });
      },
    ),
  );
  const event = userEvent.setup();
  await event.click(await screen.findByRole('combobox', { name: 'Use' }));
  await event.click(
    await screen.findByRole('option', { name: 'Selected members' }),
  );
  await event.click(await screen.findByRole('button', { name: 'Add Jane' }));
  expect(
    screen.getByText('A workspace viewer cannot gain Use through sharing.', {
      exact: false,
    }),
  ).toBeInTheDocument();
  await event.click(screen.getByRole('button', { name: 'Save sharing' }));
  await waitFor(() => {
    expect(saved).toEqual([
      { mode: 'restricted', expectedSharingRevision: 1, userIds: [userId] },
    ]);
  });
});
it('keeps unsaved members on refetch and offers an explicit reload after a conflict', async () => {
  const f = setup(),
    event = userEvent.setup();
  await event.click(await screen.findByRole('combobox', { name: 'Use' }));
  await event.click(
    await screen.findByRole('option', { name: 'Selected members' }),
  );
  await event.click(await screen.findByRole('button', { name: 'Add Jane' }));
  f.update({ connectionId, mode: 'workspace', revision: 2, members: [] });
  await act(async () => {
    await f.cache.refetchQueries({
      predicate: (query) => query.queryKey.includes('sharing'),
    });
  });
  await screen.findByText('Sharing changed.', { exact: false });
  expect(
    screen.getByRole('button', { name: 'Remove Jane' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save sharing' })).toBeDisabled();
  await event.click(
    screen.getByRole('button', { name: 'Discard edits and reload sharing' }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Remove Jane' }),
    ).not.toBeInTheDocument(),
  );
});
