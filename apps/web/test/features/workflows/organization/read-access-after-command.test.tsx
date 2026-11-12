import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { createApiClient } from '@/lib/api/client';
import { useOrganizationList } from '@/features/workflows/hooks/organization/use-organization-list';
import { useWorkflowOrganizationCommand } from '@/features/workflows/hooks/organization/use-workflow-organization-command';
import { readAccessLost } from '@/lib/api/error-copy';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import {
  api,
  userId,
  workflowId,
  workspaceId,
  workspaceWith,
  summary,
  organizedPage,
  problem,
} from '../list/fixtures';

it('keeps an authoritative list denial hidden after a pending write accepts a historical receipt', async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const workspace = accessibleWorkspaceSchema.parse(
    workspaceWith(['workflow:read', 'workflow:update']),
  );
  let forbidden = false;
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let writes = 0;
  mockServer.use(
    http.get(`${api}/workflows`, () =>
      forbidden
        ? problem(403, 'auth.forbidden')
        : HttpResponse.json(
            organizedPage({
              items: [summary(workflowId, 'Protected workflow')],
              nextCursor: null,
            }),
          ),
    ),
    http.post(`${api}/workflows/${workflowId}/folder`, async () => {
      writes += 1;
      await held;
      return HttpResponse.json({
        workflowId,
        folderId: null,
        organizationRevision: 2,
        replayed: true,
      });
    }),
  );
  const f = renderHook(
    () => ({
      list: useOrganizationList(client, userId, workspaceId, {}),
      command: useWorkflowOrganizationCommand({
        apiClient: client,
        userId,
        workspace,
        requiredRole: 'editor',
      }),
    }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={cache}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => {
    expect(f.result.current.list.isSuccess).toBe(true);
  });
  let running: Promise<void> | undefined;
  act(() => {
    running = f.result.current.command.start({
      kind: 'place-folder',
      workspaceId,
      workflowId,

      body: { folderId: null, expectedOrganizationRevision: 1 },
    });
  });
  await waitFor(() => {
    expect(writes).toBe(1);
  });
  forbidden = true;
  await act(async () => {
    await f.result.current.list.refetch();
  });
  await waitFor(() => {
    expect(readAccessLost(f.result.current.list)).toBe(true);
  });
  expect(f.result.current.list.data).toBeUndefined();
  await act(async () => {
    release();
    await running;
  });
  expect(f.result.current.list.data).toBeUndefined();
  expect(readAccessLost(f.result.current.list)).toBe(true);
  f.unmount();
  cache.clear();
});
