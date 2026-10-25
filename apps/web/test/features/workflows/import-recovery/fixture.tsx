import { createQueryClient } from '@/app/query-client';
import { NotificationsProvider } from '@/components/ui/toast';
import { WorkflowListPage } from '@/features/workflows/pages/workflow-list';
import { createApiClient } from '@/lib/api/client';
import {
  accessibleWorkspaceSchema,
  userProfileResponseSchema,
} from '@pertexo/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import { renderInRouter } from '../../../support/render-in-router';
import {
  api,
  discoveryHandlers,
  emptyGraph,
  user,
  workspaceId,
  workspaceWith,
} from '../list/fixtures';
export const fingerprint = `wf-compat:sha256:${'a'.repeat(64)}`;

export const manifest = {
  format: 'pertexo.workflow',
  graph: emptyGraph,
  requirements: {
    definitions: [],
  },
  connectionSlots: [],
};

const preview = {
  manifestDigest: 'b'.repeat(64),
  compatibilityFingerprint: fingerprint,
  compatible: true,
  issues: [],
  truncated: false,
  connectionSlots: [],
};

export const retireHistories: (() => void)[] = [];

function renderRoutedList(ui: ReactNode) {
  const previousUrl = window.location.href;
  window.history.replaceState({}, '', `/w/${workspaceId}/workflows`);
  const history = createBrowserHistory();
  retireHistories.push(() => {
    history.destroy();
    window.history.replaceState({}, '', previousUrl);
  });
  const queryClient = createQueryClient();
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspaceId/workflows',
    component: () => ui,
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspaceId',
    component: () => <h1>Destination page</h1>,
  });
  const login = createRoute({
    getParentRoute: () => root,
    path: '/login',
    component: () => <h1>Sign in destination</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([list, home, login]),
    history,
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <NotificationsProvider>
        <RouterProvider router={router} />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
}

export function mountList(
  routed = false,
  onImportSettled?: () => void,
  onIdentitySettled?: () => void,
) {
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflows`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.post(`${api}/workflows/import/preview`, () =>
      HttpResponse.json(preview),
    ),
  );
  const onCreated = vi.fn();
  const result = (routed ? renderRoutedList : renderInRouter)(
    <WorkflowListPage
      apiClient={createApiClient({
        fetch: async (...args: Parameters<typeof testFetch>) => {
          try {
            return await testFetch(...args);
          } finally {
            const input = args[0];
            const url = input instanceof Request ? input.url : String(input);
            if (url.endsWith('/workflows/import')) onImportSettled?.();
            if (url.endsWith('/users/me')) onIdentitySettled?.();
          }
        },
        readCsrfToken: () =>
          'csrf-token-for-component-tests-12345678901234567890',
      })}
      user={userProfileResponseSchema.parse(user)}
      workspace={accessibleWorkspaceSchema.parse(
        workspaceWith(['workflow:create', 'connection:read']),
      )}
      search={{}}
      onSearchChange={vi.fn()}
      onCreated={onCreated}
      onRunStarted={vi.fn()}
    />,
  );
  return { ...result, onCreated, event: userEvent.setup() };
}

export async function prepare(event: ReturnType<typeof userEvent.setup>) {
  await event.click(
    await screen.findByRole('button', { name: 'Import workflow…' }),
  );
  await event.upload(
    await screen.findByLabelText('Workflow JSON file'),
    new File([JSON.stringify(manifest)], 'portable.json', {
      type: 'application/json',
    }),
  );
  await screen.findByLabelText('Complete imported graph');
  await event.type(
    screen.getByLabelText('New workflow name'),
    'Frozen recovery draft',
  );
  await event.click(screen.getByRole('button', { name: 'Preview import' }));
  await screen.findByText(/Compatible with this workspace/u);
  await event.click(
    screen.getByRole('button', { name: 'Import unpublished draft' }),
  );
}
