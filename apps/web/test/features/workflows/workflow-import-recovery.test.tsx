import { HttpResponse, http } from 'msw';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  userProfileResponseSchema,
} from '@pertexo/contracts';
import { WorkflowListPage } from '@/features/workflows/pages/workflow-list';
import { createApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/api-error';
import { workflowKeys } from '@/features/workflows/queries.public';
import { createQueryClient } from '@/app/query-client';
import { NotificationsProvider } from '@/components/ui/toast';
import { mockServer } from '../../support/mock-server';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import {
  api,
  discoveryHandlers,
  emptyGraph,
  user,
  workspaceWith,
  versionId,
  problem,
  userId,
  workflowId,
  workspaceId,
} from './workflow-list.fixtures';

const fingerprint = `wf-compat:v1:sha256:${'a'.repeat(64)}`;
const manifest = {
  format: 'pertexo.workflow',
  formatVersion: 1,
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

const retireHistories: (() => void)[] = [];
afterEach(() => {
  for (const retire of retireHistories.splice(0)) retire();
});

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

function mountList(
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

async function prepare(event: ReturnType<typeof userEvent.setup>) {
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

describe('Workflow list owns import recovery across dialog dismissal', () => {
  it('starts another import only after confirmed recovery, clears setup without POST, and creates a fresh explicit key', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(1);
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('New workflow name')).toBeEnabled();
    });
    expect(screen.getByLabelText('New workflow name')).toHaveValue('');
    expect(screen.getByLabelText('Workflow JSON file')).toHaveValue('');
    expect(
      screen.queryByLabelText('Complete imported graph'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Compatible with this workspace/u),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start another import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
    expect(attempts).toHaveLength(1);
    await event.upload(
      screen.getByLabelText('Workflow JSON file'),
      new File([JSON.stringify(manifest)], 'second.json', {
        type: 'application/json',
      }),
    );
    await screen.findByLabelText('Complete imported graph');
    await event.type(
      screen.getByLabelText('New workflow name'),
      'Deliberate second draft',
    );
    await event.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/Compatible with this workspace/u);
    expect(attempts).toHaveLength(1);
    await event.click(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    );
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.key).toBeTruthy();
    expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
    expect(attempts[1]?.body).toEqual({
      manifest,
      bindings: [],
      name: 'Deliberate second draft',
      expectedCompatibilityFingerprint: fingerprint,
    });
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Workflow JSON file')).toHaveValue('');
    });
    expect(attempts).toHaveLength(2);
  });

  it.each(['sending', 'uncertain', 'denied'] as const)(
    'offers no reset action while %s',
    async (state) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let posted = 0;
      mockServer.use(
        http.post(`${api}/workflows/import`, async () => {
          posted += 1;
          if (state === 'sending') {
            await held;
            return HttpResponse.json(
              { workflowId: versionId },
              { status: 201 },
            );
          }
          return state === 'denied'
            ? problem(403, 'authorization.forbidden')
            : HttpResponse.error();
        }),
      );
      const { event } = mountList();
      await prepare(event);
      if (state === 'sending') {
        await waitFor(() => {
          expect(posted).toBe(1);
        });
        expect(
          screen.getByRole('button', { name: 'Importing…' }),
        ).toBeDisabled();
      } else if (state === 'uncertain')
        await screen.findByRole('button', { name: 'Retry exact import' });
      else await screen.findByText(/Access changed/u);
      expect(
        screen.queryByRole('button', { name: 'Start another import' }),
      ).not.toBeInTheDocument();
      expect(posted).toBe(1);
      if (state === 'sending') {
        release();
        await screen.findByRole('button', { name: 'Open imported workflow' });
      }
    },
  );

  it('retires reset on lost authority and fences a late successful verification without another POST', async () => {
    let posted = 0;
    mockServer.use(
      http.post(`${api}/workflows/import`, () => {
        posted += 1;
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    let verifying = false;
    let release!: () => void;
    let serverSettled!: () => void;
    let transportSettled!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const serverResponse = new Promise<void>((resolve) => {
      serverSettled = resolve;
    });
    const transportResponse = new Promise<void>((resolve) => {
      transportSettled = resolve;
    });
    const { event, queryClient, onCreated } = mountList(
      false,
      undefined,
      () => {
        if (verifying) transportSettled();
      },
    );
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', async () => {
        verifying = true;
        await held;
        serverSettled();
        return HttpResponse.json(user);
      }),
    );
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() => {
      expect(verifying).toBe(true);
    });
    await queryClient
      .query({
        queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
        queryFn: () =>
          Promise.reject(
            new ApiError({ kind: 'problem', message: 'Denied', status: 403 }),
          ),
        retry: false,
      })
      .catch(() => undefined);
    await screen.findByText(/Access changed/u);
    await act(async () => {
      release();
      await serverResponse;
      await transportResponse;
    });
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start another import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(posted).toBe(1);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('retains the known confirmed destination when reset authority verification has a transport outage', async () => {
    let posted = 0;
    mockServer.use(
      http.post(`${api}/workflows/import`, () => {
        posted += 1;
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    let checked = false;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        checked = true;
        return HttpResponse.error();
      }),
    );
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() => {
      expect(checked).toBe(true);
    });
    await screen.findByRole('button', { name: 'Start another import' });
    expect(
      screen.getByRole('button', { name: 'Open imported workflow' }),
    ).toBeEnabled();
    expect(screen.getByLabelText('New workflow name')).toHaveValue(
      'Frozen recovery draft',
    );
    expect(screen.getByLabelText('New workflow name')).toBeDisabled();
    expect(posted).toBe(1);
  });

  it('retains a lost accepted response through Close/reopen and only manually replays the exact body/key', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        // The server accepted the first command, but its response was lost.
        return attempts.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, onCreated } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Retry exact import' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Import workflow' }),
      ).not.toBeInTheDocument(),
    );
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    const retry = await screen.findByRole('button', {
      name: 'Retry exact import',
    });
    expect(attempts).toHaveLength(1);
    expect(screen.getByLabelText('New workflow name')).toBeDisabled();
    await event.click(retry);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.key).toBeTruthy();
    await event.click(
      screen.getByRole('button', { name: 'Open imported workflow' }),
    );
    expect(onCreated).toHaveBeenCalledWith(versionId);
    expect(attempts).toHaveLength(2);
  });

  it('keeps an in-flight accepted command through Cancel/reopen without sending a replacement or auto-retrying', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        if (attempts.length === 1) {
          await held;
          return HttpResponse.error();
        }
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event } = mountList();
    await prepare(event);
    await waitFor(() => {
      expect(attempts).toHaveLength(1);
    });
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Import workflow' }),
      ).not.toBeInTheDocument(),
    );
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    release();
    const retry = await screen.findByRole('button', {
      name: 'Retry exact import',
    });
    expect(attempts).toHaveLength(1);
    await event.click(retry);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it('clears retained private intent after access loss while dismissed and fences a late accepted response', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posted = 0;
    let serverSettled!: () => void;
    const serverResponse = new Promise<void>((resolve) => {
      serverSettled = resolve;
    });
    let transportSettled!: () => void;
    const transportResponse = new Promise<void>((resolve) => {
      transportSettled = resolve;
    });
    mockServer.use(
      http.post(`${api}/workflows/import`, async () => {
        posted += 1;
        await held;
        serverSettled();
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, queryClient, onCreated } = mountList(
      false,
      transportSettled,
    );
    await prepare(event);
    await waitFor(() => {
      expect(posted).toBe(1);
    });
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Import workflow' }),
      ).not.toBeInTheDocument(),
    );
    await queryClient
      .query({
        queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
        queryFn: () =>
          Promise.reject(
            new ApiError({ kind: 'problem', message: 'Denied', status: 403 }),
          ),
        retry: false,
      })
      .catch(() => undefined);
    await act(async () => {
      release();
      await serverResponse;
      await transportResponse;
    });
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByText(/Access changed/u);
    expect(
      screen.queryByLabelText('Complete imported graph'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry exact import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(posted).toBe(1);
  });

  it('blocks same-workspace departure while uncertain, offers Stay/reopen, and releases a confirmed command without another POST', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return attempts.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, router } = mountList(true);
    await prepare(event);
    await screen.findByRole('button', { name: 'Retry exact import' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    void router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    await screen.findByRole('heading', {
      name: 'Resolve the import before leaving',
    });
    expect(router.state.location.pathname).toBe(`/w/${workspaceId}/workflows`);
    await event.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(
      screen.queryByRole('heading', { name: 'Destination page' }),
    ).not.toBeInTheDocument();
    void router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    await event.click(
      await screen.findByRole('button', { name: 'Reopen import' }),
    );
    expect(attempts).toHaveLength(1);
    await event.click(
      await screen.findByRole('button', { name: 'Retry exact import' }),
    );
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts[1]).toEqual(attempts[0]);
    await event.click(screen.getByRole('button', { name: 'Close' }));
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    const settledUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
    await router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    await screen.findByRole('heading', { name: 'Destination page' });
  });

  it.each(['session departure', 'workspace change'] as const)(
    'does not prevent %s during sending, and fences the late accepted response',
    async (departure) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let posted = 0;
      let serverSettled!: () => void;
      const serverResponse = new Promise<void>((resolve) => {
        serverSettled = resolve;
      });
      let transportSettled!: () => void;
      const transportResponse = new Promise<void>((resolve) => {
        transportSettled = resolve;
      });
      mockServer.use(
        http.post(`${api}/workflows/import`, async () => {
          posted += 1;
          await held;
          serverSettled();
          return HttpResponse.json({ workflowId: versionId }, { status: 201 });
        }),
      );
      const { event, router, onCreated } = mountList(true, transportSettled);
      await prepare(event);
      await waitFor(() => {
        expect(posted).toBe(1);
      });
      await event.click(screen.getByRole('button', { name: 'Cancel' }));
      void router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
      await screen.findByRole('heading', {
        name: 'Resolve the import before leaving',
      });
      await event.click(screen.getByRole('button', { name: 'Stay here' }));
      if (departure === 'session departure') {
        await router.navigate({ to: '/login' });
        await screen.findByRole('heading', { name: 'Sign in destination' });
      } else {
        await router.navigate({
          to: '/w/$workspaceId',
          params: { workspaceId: versionId },
        });
        await screen.findByRole('heading', { name: 'Destination page' });
        expect(router.state.location.pathname).toBe(`/w/${versionId}`);
      }
      await act(async () => {
        release();
        await serverResponse;
        await transportResponse;
      });
      expect(onCreated).not.toHaveBeenCalled();
      expect(posted).toBe(1);
      expect(
        screen.queryByRole('button', { name: 'Open imported workflow' }),
      ).not.toBeInTheDocument();
    },
  );

  it('retires hidden recovery on a cross-tab session change and fences an accepted response', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posted = 0;
    let serverSettled!: () => void;
    const serverResponse = new Promise<void>((resolve) => {
      serverSettled = resolve;
    });
    let transportSettled!: () => void;
    const transportResponse = new Promise<void>((resolve) => {
      transportSettled = resolve;
    });
    mockServer.use(
      http.post(`${api}/workflows/import`, async () => {
        posted += 1;
        await held;
        serverSettled();
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, onCreated } = mountList(false, transportSettled);
    await prepare(event);
    await waitFor(() => {
      expect(posted).toBe(1);
    });
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'pertexo:auth-session-change:v1',
        newValue: JSON.stringify({
          event: 'changed',
          generation: 'new-session',
          sender: 'other-tab',
        }),
      }),
    );
    await act(async () => {
      release();
      await serverResponse;
      await transportResponse;
    });
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByText(/Access changed/u);
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry exact import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(posted).toBe(1);
  });

  it('releases blocked same-scope departure on authority loss while retaining no recoverable payload', async () => {
    mockServer.use(
      http.post(`${api}/workflows/import`, () => HttpResponse.error()),
    );
    const { event, router, queryClient } = mountList(true);
    await prepare(event);
    await screen.findByRole('button', { name: 'Retry exact import' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    void router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    await screen.findByRole('heading', {
      name: 'Resolve the import before leaving',
    });
    await queryClient
      .query({
        queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
        queryFn: () =>
          Promise.reject(
            new ApiError({ kind: 'problem', message: 'Denied', status: 403 }),
          ),
        retry: false,
      })
      .catch(() => undefined);
    await screen.findByRole('heading', { name: 'Destination page' });
    expect(
      screen.queryByRole('button', { name: 'Retry exact import' }),
    ).not.toBeInTheDocument();
  });
});
