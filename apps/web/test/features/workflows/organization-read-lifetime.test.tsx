import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { workflowSummarySchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { useOrganizationList } from '@/features/workflows/use-organization-list';
import { WorkflowOrganizationFilters } from '@/features/workflows/components/organization/workflow-organization-filters';
import { workflowOrganizationKeys } from '@/features/workflows/organization.queries';
import {
  getWorkflowOrganizationPage,
  getWorkflowFolders,
  getWorkflowTagsPage,
  sendWorkflowOrganizationCommand,
} from '@/features/workflows/organization.api';
import { useWorkflowOrganizationCommand } from '@/features/workflows/use-workflow-organization-command';
import { assertSessionIdentity } from '@/features/auth/session-identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { ApiError } from '@/lib/api/api-error';
import { createApiClient } from '@/lib/api/client';
import {
  userId,
  workspaceId,
  workflowId,
  summary,
  workspaceWith,
  user,
} from './workflow-list.fixtures';
import type { WorkflowListSearch } from '@/features/workflows/model/workflow-list-view';

vi.mock('@/features/workflows/organization.api', async (original) => ({
  ...(await original<object>()),
  getWorkflowOrganizationPage: vi.fn(),
  getWorkflowFolders: vi.fn(),
  getWorkflowTagsPage: vi.fn(),
  sendWorkflowOrganizationCommand: vi.fn(),
}));
vi.mock('@/features/auth/session-identity.public', async (original) => ({
  ...(await original<object>()),
  assertSessionIdentity: vi.fn(),
}));
vi.mock('@/features/workspaces/queries.public', async (original) => ({
  ...(await original<object>()),
  getAllAccessibleWorkspaces: vi.fn(),
}));
const apiClient = createApiClient({
  fetch: vi.fn(),
  readCsrfToken: () => undefined,
});
const folderId = '11111111-1111-4111-8111-111111111111';
const tagId = '22222222-2222-4222-8222-222222222222';
const workspace = accessibleWorkspaceSchema.parse(workspaceWith([]));
const folders = {
  items: [
    {
      id: folderId,
      name: 'Private folder',
      revision: 1,
      parentId: null,
      depth: 1,
    },
  ],
};
const tags = {
  items: [{ id: tagId, key: 'private-tag', revision: 1 }],
  nextCursor: null,
};
const page = {
  items: [
    {
      workflow: workflowSummarySchema.parse(
        summary(workflowId, 'Protected workflow'),
      ),
      organization: {
        folderId,
        tags: tags.items,
        organizationRevision: 1,
        isFavorite: true,
        favoriteRevision: workflowId,
      },
    },
  ],
  nextCursor: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function denied(status: number) {
  return new ApiError({ kind: 'problem', status, message: 'private body' });
}
function Probe({
  actor = userId,
  tenant = workspaceId,
}: Readonly<{ actor?: string; tenant?: string }>) {
  const result = useOrganizationList(apiClient, actor, tenant, {}, true);
  return (
    <>
      <button onClick={() => void result.refetch()}>
        Refresh workflow reads
      </button>
      {result.data?.pages
        .flatMap((entry) => entry.organizations)
        .map((entry) => (
          <p key={entry.workflow.id}>
            {entry.workflow.name}{' '}
            {entry.organization.isFavorite ? 'Private favorite' : ''}
          </p>
        ))}
      {result.isError ? <p>Workflow reads unavailable</p> : null}
      <WorkflowOrganizationFilters
        apiClient={apiClient}
        userId={actor}
        workspace={{ ...workspace, id: tenant }}
        search={{ folderId, tagId }}
        filterRef={null}
        onSearchChange={() => undefined}
      />
    </>
  );
}
function setup(
  actor = userId,
  tenant = workspaceId,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  }),
) {
  const view = render(
    <QueryClientProvider client={client}>
      <Probe actor={actor} tenant={tenant} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    rerenderScope: (nextActor: string, nextTenant: string) => {
      view.rerender(
        <QueryClientProvider client={client}>
          <Probe actor={nextActor} tenant={nextTenant} />
        </QueryClientProvider>,
      );
    },
  };
}
async function ready() {
  await screen.findByText('Protected workflow Private favorite');
  await screen.findByText('Private folder');
  await screen.findByText('private-tag');
}
async function forgotten(client: QueryClient) {
  await waitFor(() => {
    expect(
      screen.queryByText('Protected workflow Private favorite'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Private folder')).not.toBeInTheDocument();
    expect(screen.queryByText('private-tag')).not.toBeInTheDocument();
    const scoped = client.getQueryCache().findAll({
      queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
    });
    expect(scoped.every((query) => query.state.data === undefined)).toBe(true);
  });
}
beforeEach(() => {
  vi.mocked(assertSessionIdentity)
    .mockReset()
    .mockResolvedValue({ ...user, status: 'active' });
  vi.mocked(getAllAccessibleWorkspaces)
    .mockReset()
    .mockResolvedValue([workspace]);
  vi.mocked(sendWorkflowOrganizationCommand).mockReset();
  vi.mocked(getWorkflowOrganizationPage).mockReset().mockResolvedValue(page);
  vi.mocked(getWorkflowFolders).mockReset().mockResolvedValue(folders);
  vi.mocked(getWorkflowTagsPage).mockReset().mockResolvedValue(tags);
});

describe('organization reads without a command dialog', () => {
  it('immutable query denial reaches a later command owner after the earlier read owner cancels query state', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const receipt = {
      workflowId,
      folderId: null,
      organizationRevision: 2,
      replayed: true,
    };
    const held = deferred<typeof receipt>();
    vi.mocked(sendWorkflowOrganizationCommand).mockReturnValue(held.promise);
    const hook = renderHook(
      () => {
        const list = useOrganizationList(
          apiClient,
          userId,
          workspaceId,
          {},
          true,
        );
        const command = useWorkflowOrganizationCommand({
          apiClient,
          userId,
          workspace,
          requiredRole: 'editor',
        });
        return { list, command };
      },
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => {
      expect(hook.result.current.list.isSuccess).toBe(true);
    });
    let running!: Promise<void>;
    act(() => {
      running = hook.result.current.command.start({
        kind: 'place-folder',
        workspaceId,
        workflowId,
        idempotencyKey: 'original-command-key',
        body: { folderId: null, expectedOrganizationRevision: 1 },
      });
    });
    await waitFor(() => {
      expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(1);
    });
    const signal = vi.mocked(sendWorkflowOrganizationCommand).mock
      .calls[0]?.[2];
    vi.mocked(getWorkflowOrganizationPage).mockRejectedValue(denied(403));
    await act(async () => {
      await hook.result.current.list.refetch();
    });
    await waitFor(() => {
      expect(hook.result.current.command.denied).toBe(true);
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      held.resolve(receipt);
      await running;
    });
    expect(hook.result.current.command.result).toBeUndefined();
    expect(hook.result.current.command.retryAvailable).toBe(false);
    expect(hook.result.current.list.data).toBeUndefined();
  });

  it('explicit fresh read recovers after denial but a transient retry cannot resurrect the denied snapshot', async () => {
    const { client } = setup();
    await ready();
    vi.mocked(getWorkflowOrganizationPage).mockRejectedValue(denied(403));
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh workflow reads' }),
    );
    await forgotten(client);
    vi.mocked(getWorkflowOrganizationPage).mockRejectedValue(
      new ApiError({ kind: 'problem', status: 503, message: 'unavailable' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh workflow reads' }),
    );
    await forgotten(client);
    vi.mocked(getWorkflowOrganizationPage).mockResolvedValue(page);
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh workflow reads' }),
    );
    await screen.findByText('Protected workflow Private favorite');
  });
  it('composes rapid independent filter changes against current URL state while props await navigation', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let current: WorkflowListSearch = {
      view: 'all',
      sort: 'created',
      create: true,
    };
    render(
      <QueryClientProvider client={client}>
        <WorkflowOrganizationFilters
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          search={current}
          filterRef={null}
          onSearchChange={(
            next:
              | WorkflowListSearch
              | ((search: WorkflowListSearch) => WorkflowListSearch),
          ) => {
            current = typeof next === 'function' ? next(current) : next;
          }}
        />
      </QueryClientProvider>,
    );
    const event = userEvent.setup();
    await event.type(screen.getByLabelText('Name contains'), 'Alpha');
    await event.click(screen.getByRole('button', { name: 'Search' }));
    await event.click(screen.getByRole('combobox', { name: 'Filter by tag' }));
    await event.click(
      await screen.findByRole('option', { name: 'private-tag' }),
    );
    await event.click(
      screen.getByRole('combobox', { name: 'Filter by folder' }),
    );
    await event.click(
      await screen.findByRole('option', { name: 'Private folder' }),
    );
    await event.click(screen.getByRole('button', { name: 'My favorites' }));
    expect(current).toEqual({
      view: 'all',
      sort: 'created',
      create: true,
      query: 'Alpha',
      favoritesOnly: 'true',
      tagId,
      folderId,
    });
    await event.click(screen.getByRole('button', { name: 'My favorites' }));
    expect(current.favoritesOnly).toBeUndefined();
    expect(current.query).toBe('Alpha');
    await event.clear(screen.getByLabelText('Name contains'));
    await event.click(screen.getByRole('button', { name: 'Search' }));
    expect(current.query).toBeUndefined();
    expect(current.tagId).toBe(tagId);
    expect(current.folderId).toBe(folderId);
    await event.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(current).toEqual({ view: 'all', sort: 'created', create: true });
  });
  it.each([401, 403, 404])(
    'forgets all organization siblings on %s without touching legacy/F06/other scopes',
    async (status) => {
      const { client } = setup();
      await ready();
      const preserved = [
        ['identity', userId, 'workspace', workspaceId, 'workflows', 'list'],
        ['identity', userId, 'workspace', workspaceId, 'workflow-origin'],
        workflowOrganizationKeys.scope('other-actor', workspaceId),
        workflowOrganizationKeys.scope(userId, 'other-workspace'),
      ];
      for (const key of preserved)
        client.setQueryData(key, { snapshot: 'untouched' });
      vi.mocked(getWorkflowOrganizationPage).mockRejectedValue(denied(status));
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh workflow reads' }),
      );
      await forgotten(client);
      for (const key of preserved)
        expect(client.getQueryData(key)).toEqual({ snapshot: 'untouched' });
      expect(getWorkflowOrganizationPage).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole('combobox', { name: 'Filter by tag' }),
      ).toBeDisabled();
    },
  );

  it('cancels a held sibling before removal even when transport ignores cancellation', async () => {
    const { client } = setup();
    await ready();
    const held = deferred<typeof tags>();
    vi.mocked(getWorkflowTagsPage).mockReturnValueOnce(held.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = client.invalidateQueries({
        queryKey: workflowOrganizationKeys.tags(userId, workspaceId),
      });
    });
    await waitFor(() => {
      expect(getWorkflowTagsPage).toHaveBeenCalledTimes(2);
    });
    const signal = vi.mocked(getWorkflowTagsPage).mock.calls[1]?.[3];
    vi.mocked(getWorkflowOrganizationPage).mockRejectedValue(denied(403));
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh workflow reads' }),
    );
    await forgotten(client);
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      held.resolve(tags);
      await refresh;
    });
    await forgotten(client);
  });

  it.each([
    new ApiError({
      kind: 'problem',
      status: 503,
      message: 'service unavailable',
    }),
    new ApiError({ kind: 'network', message: 'offline' }),
  ])(
    'retains authorized stale metadata on a transient read failure',
    async (error) => {
      const { client } = setup();
      await ready();
      vi.mocked(getWorkflowOrganizationPage).mockRejectedValue(error);
      vi.mocked(getWorkflowFolders).mockRejectedValue(error);
      await act(async () => {
        await client.invalidateQueries({
          queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
        });
      });
      await ready();
      await screen.findByText(/Showing the last authorized vocabulary/);
      expect(
        client.getQueryData(
          workflowOrganizationKeys.folders(userId, workspaceId),
        ),
      ).toEqual(folders);
    },
  );

  it.each([false, true])(
    'remount uses a fresh read, never denied or held cached metadata (authorized=%s)',
    async (authorized) => {
      const view = setup();
      await ready();
      vi.mocked(getWorkflowOrganizationPage).mockRejectedValue(denied(404));
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh workflow reads' }),
      );
      await forgotten(view.client);
      view.unmount();
      const fresh = deferred<typeof page>();
      vi.mocked(getWorkflowOrganizationPage).mockReturnValueOnce(fresh.promise);
      vi.mocked(getWorkflowFolders).mockRejectedValue(denied(403));
      vi.mocked(getWorkflowTagsPage).mockRejectedValue(denied(403));
      if (authorized) {
        vi.mocked(getWorkflowFolders).mockResolvedValue(folders);
        vi.mocked(getWorkflowTagsPage).mockResolvedValue(tags);
      }
      setup(userId, workspaceId, view.client);
      expect(
        screen.queryByText('Protected workflow Private favorite'),
      ).not.toBeInTheDocument();
      act(() => {
        fresh.resolve(page);
      });
      if (authorized) await ready();
      else await forgotten(view.client);
    },
  );

  it.each(['actor', 'workspace'] as const)(
    'an old scoped late reply cannot affect a new %s read owner',
    async (changing) => {
      const view = setup();
      await ready();
      const held = deferred<typeof page>();
      vi.mocked(getWorkflowOrganizationPage).mockReturnValueOnce(held.promise);
      act(() => {
        void view.client.invalidateQueries({
          queryKey: [
            ...workflowOrganizationKeys.scope(userId, workspaceId),
            'list',
          ],
        });
      });
      await waitFor(() => {
        expect(getWorkflowOrganizationPage).toHaveBeenCalledTimes(2);
      });
      const oldSignal = vi.mocked(getWorkflowOrganizationPage).mock
        .calls[1]?.[3];
      const current = {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          workflow: { ...item.workflow, name: 'Current authorized workflow' },
          organization: { ...item.organization, isFavorite: false },
        })),
      };
      vi.mocked(getWorkflowOrganizationPage).mockResolvedValue(current);
      view.rerenderScope(
        changing === 'actor' ? 'other-actor' : userId,
        changing === 'workspace' ? 'other-workspace' : workspaceId,
      );
      await screen.findByText('Current authorized workflow');
      expect(oldSignal?.aborted).toBe(true);
      act(() => {
        held.resolve(page);
      });
      expect(
        screen.queryByText('Protected workflow Private favorite'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Current authorized workflow')).toBeVisible();
    },
  );
});
