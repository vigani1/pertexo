import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  apiProblemSchema,
} from '@pertexo/contracts';
import { assertSessionIdentity } from '@/features/auth/session-identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { sendWorkflowOrganizationCommand } from '@/features/workflows/organization.api';
import {
  useWorkflowOrganizationCommand,
  type WorkflowOrganizationCommandOptions,
} from '@/features/workflows/use-workflow-organization-command';
import type { WorkflowOrganizationAttempt } from '@/features/workflows/model/workflow-organization';
import { workflowOrganizationKeys } from '@/features/workflows/organization.queries';
import { workflowKeys } from '@/features/workflows/workflows.queries';
import { ApiError } from '@/lib/api/api-error';
import { createApiClient } from '@/lib/api/client';
import {
  user,
  userId,
  workspaceId,
  workflowId,
  secondWorkflowId,
  workspaceWith,
} from './workflow-list.fixtures';

const session = vi.hoisted(() => ({
  listener: undefined as (() => void) | undefined,
  unsubscribe: vi.fn(),
}));
vi.mock('@/features/auth/session-sync.public', () => ({
  subscribeSessionChanges: (listener: () => void) => {
    session.listener = listener;
    return session.unsubscribe;
  },
}));
vi.mock('@/features/auth/session-identity.public', async (original) => ({
  ...(await original<object>()),
  assertSessionIdentity: vi.fn(),
}));
vi.mock('@/features/workspaces/queries.public', () => ({
  getAllAccessibleWorkspaces: vi.fn(),
}));
vi.mock('@/features/workflows/organization.api', async (original) => ({
  ...(await original<object>()),
  sendWorkflowOrganizationCommand: vi.fn(),
}));

const workspace = accessibleWorkspaceSchema.parse(
  workspaceWith(['workflow:read', 'workflow:update']),
);
const apiClient = createApiClient({
  fetch: vi.fn(),
  readCsrfToken: () => undefined,
});
const single: WorkflowOrganizationAttempt = {
  workspaceId,
  idempotencyKey: 'single-key',
  kind: 'place-folder',
  workflowId,
  body: { folderId: null, expectedOrganizationRevision: 7 },
};
const receipt = {
  workflowId,
  folderId: null,
  organizationRevision: 2,
  replayed: true,
};
function bulk(): WorkflowOrganizationAttempt & { kind: 'bulk' } {
  return {
    workspaceId,
    idempotencyKey: 'whole-parent-key',
    kind: 'bulk',
    body: {
      operation: 'move',
      folderId: null,
      items: [
        { workflowId: secondWorkflowId, expectedOrganizationRevision: 4 },
        { workflowId, expectedOrganizationRevision: 7 },
      ],
    },
  };
}
const partial = {
  items: [
    {
      workflowId: secondWorkflowId,
      status: 'updated' as const,
      organizationRevision: 5,
      replayed: false,
    },
    { workflowId, status: 'outcome_unknown' as const },
  ],
};
const network = () =>
  new ApiError({ kind: 'network', message: 'private-error-body' });
function deferred() {
  let resolve!: (result: typeof receipt) => void;
  const promise = new Promise<typeof receipt>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function setup(overrides: Partial<WorkflowOrganizationCommandOptions> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props = {
    apiClient,
    userId,
    workspace,
    requiredRole: 'editor' as const,
    ...overrides,
  };
  const hook = renderHook(
    (input: WorkflowOrganizationCommandOptions) =>
      useWorkflowOrganizationCommand(input),
    {
      initialProps: props,
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  return { ...hook, queryClient, props };
}
beforeEach(() => {
  vi.clearAllMocks();
  session.listener = undefined;
  vi.mocked(assertSessionIdentity)
    .mockReset()
    .mockResolvedValue({ ...user, status: 'active' });
  vi.mocked(getAllAccessibleWorkspaces)
    .mockReset()
    .mockResolvedValue([workspace]);
  vi.mocked(sendWorkflowOrganizationCommand)
    .mockReset()
    .mockResolvedValue(receipt);
});

describe('ephemeral organization command lifetime', () => {
  it.each([
    { requiredRole: 'member', role: 'viewer', accepted: true },
    { requiredRole: 'editor', role: 'builder', accepted: true },
    { requiredRole: 'editor', role: 'viewer', accepted: false },
    { requiredRole: 'admin', role: 'builder', accepted: false },
    { requiredRole: 'admin', role: 'admin', accepted: true },
    { requiredRole: 'admin', role: 'owner', accepted: true },
  ] as const)(
    'requires fresh active $requiredRole authority for $role',
    async ({ requiredRole, role, accepted }) => {
      const current = { ...workspace, role };
      vi.mocked(getAllAccessibleWorkspaces).mockResolvedValue([current]);
      const f = setup({ workspace: current, requiredRole });
      await act(() => f.result.current.start(single));
      expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(
        accepted ? 1 : 0,
      );
      expect(f.result.current.denied).toBe(!accepted);
    },
  );

  it('retains ordered public forbidden feedback but retires its private attempt', async () => {
    const f = setup();
    const response = {
      items: [
        { workflowId: secondWorkflowId, status: 'forbidden' as const },
        { workflowId, status: 'not_processed' as const },
      ],
    };
    vi.mocked(sendWorkflowOrganizationCommand).mockResolvedValueOnce(response);
    await act(() => f.result.current.start(bulk()));
    expect(f.result.current.result).toEqual(response);
    expect(f.result.current.denied).toBe(true);
    expect(f.result.current.retryAvailable).toBe(false);
    await act(async () => {
      await f.result.current.retry();
      await f.result.current.start(single);
    });
    expect(sendWorkflowOrganizationCommand).toHaveBeenCalledOnce();
    act(() => {
      session.listener?.();
    });
    expect(f.result.current.result).toBeUndefined();
  });

  it('does not retire from an unrelated feature denial, but observes identity changes', async () => {
    const f = setup();
    vi.mocked(sendWorkflowOrganizationCommand).mockRejectedValueOnce(network());
    await act(() => f.result.current.start(single));
    act(() => {
      const query = f.queryClient.getQueryCache().build(f.queryClient, {
        queryKey: ['identity', userId, 'workspace', workspaceId, 'concurrency'],
      });
      query.setState({
        status: 'error',
        error: new ApiError({
          kind: 'problem',
          status: 403,
          message: 'private',
        }),
      });
    });
    expect(f.result.current.denied).toBe(false);
    expect(f.result.current.retryAvailable).toBe(true);
    act(() => {
      f.queryClient.setQueryData(['identity', 'current-user'], {
        ...user,
        id: secondWorkflowId,
      });
    });
    expect(f.result.current.denied).toBe(true);
    expect(f.result.current.retryAvailable).toBe(false);
  });

  it('requires fresh read capability and clears only sibling organization caches on access loss', async () => {
    const f = setup();
    const organization = workflowOrganizationKeys.scope(userId, workspaceId);
    const unrelated = [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'portability',
    ] as const;
    f.queryClient.setQueryData(organization, { revision: 9 });
    f.queryClient.setQueryData(unrelated, { exactRecovery: true });
    f.queryClient.setQueryData(workflowKeys.scope(userId, workspaceId), {
      currentWorkflow: true,
    });
    vi.mocked(getAllAccessibleWorkspaces).mockResolvedValueOnce([
      { ...workspace, capabilities: [] },
    ]);
    await act(() => f.result.current.start(single));
    expect(f.result.current.denied).toBe(true);
    expect(sendWorkflowOrganizationCommand).not.toHaveBeenCalled();
    expect(f.queryClient.getQueryData(organization)).toBeUndefined();
    expect(f.queryClient.getQueryData(unrelated)).toEqual({
      exactRecovery: true,
    });
    expect(
      f.queryClient.getQueryData(workflowKeys.scope(userId, workspaceId)),
    ).toEqual({ currentWorkflow: true });
  });

  it('preserves exact whole-parent recovery when an item is unavailable', async () => {
    const f = setup();
    const response = {
      items: [
        {
          workflowId: secondWorkflowId,
          status: 'unavailable' as const,
          code: 'workflow.organization_unavailable' as const,
        },
        {
          workflowId,
          status: 'updated' as const,
          organizationRevision: 8,
          replayed: true,
        },
      ],
    };
    vi.mocked(sendWorkflowOrganizationCommand)
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(response);
    await act(() => f.result.current.start(bulk()));
    expect(f.result.current.retryAvailable).toBe(true);
    await act(() => f.result.current.retry());
    expect(vi.mocked(sendWorkflowOrganizationCommand).mock.calls[1]?.[1]).toBe(
      vi.mocked(sendWorkflowOrganizationCommand).mock.calls[0]?.[1],
    );
  });

  it('does not reset an outstanding command or release a different intent before its known result', async () => {
    const f = setup();
    const older = deferred(),
      newer = deferred();
    vi.mocked(sendWorkflowOrganizationCommand)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    act(() => {
      first = f.result.current.start(single);
    });
    await waitFor(() => {
      expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(1);
    });
    act(() => {
      f.result.current.reset();
      second = f.result.current.start({ ...single, idempotencyKey: 'new-key' });
    });
    expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(1);
    expect(f.result.current.pending).toBe(true);
    expect(
      vi.mocked(sendWorkflowOrganizationCommand).mock.calls[0]?.[2]?.aborted,
    ).toBe(false);
    await act(async () => {
      older.resolve(receipt);
      await first;
    });
    expect(f.result.current.pending).toBe(false);
    expect(f.result.current.result).toEqual(receipt);
    act(() => {
      f.result.current.reset();
      second = f.result.current.start({ ...single, idempotencyKey: 'new-key' });
    });
    await waitFor(() => {
      expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      newer.resolve({ ...receipt, organizationRevision: 9 });
      await second;
    });
    expect(f.result.current.result).toEqual({
      ...receipt,
      organizationRevision: 9,
    });
  });

  it('invalidates both current sibling scopes without projecting historical receipt revisions', async () => {
    const f = setup();
    const organizationKey = workflowOrganizationKeys.detail(
      userId,
      workspaceId,
      workflowId,
      { include: 'organization' },
    );
    const legacyKey = workflowKeys.detail(userId, workspaceId, workflowId);
    const snapshot = { organizationRevision: 99, folderId: secondWorkflowId };
    f.queryClient.setQueryData(organizationKey, snapshot);
    f.queryClient.setQueryData(legacyKey, snapshot);
    await act(() => f.result.current.start(single));
    expect(f.result.current.result).toEqual(receipt);
    expect(f.queryClient.getQueryData(organizationKey)).toEqual(snapshot);
    expect(f.queryClient.getQueryData(legacyKey)).toEqual(snapshot);
    expect(f.queryClient.getQueryState(organizationKey)?.isInvalidated).toBe(
      true,
    );
    expect(f.queryClient.getQueryState(legacyKey)?.isInvalidated).toBe(true);
    expect(f.queryClient.getMutationCache().getAll()).toEqual([]);
    expect(assertSessionIdentity).toHaveBeenCalledTimes(2);
    expect(getAllAccessibleWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('retains the entire unresolved parent through reset and permits a new intent only after definitive recovery', async () => {
    const f = setup();
    const input = bulk();
    vi.mocked(sendWorkflowOrganizationCommand)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce({
        items: [
          {
            workflowId: secondWorkflowId,
            status: 'updated',
            organizationRevision: 5,
            replayed: true,
          },
          {
            workflowId,
            status: 'updated',
            organizationRevision: 8,
            replayed: false,
          },
        ],
      });
    await act(() => f.result.current.start(input));
    expect(f.result.current.retryAvailable).toBe(true);
    expect(f.result.current.result).toEqual(partial);
    const captured = vi.mocked(sendWorkflowOrganizationCommand).mock
      .calls[0]?.[1];
    expect(Object.isFrozen(captured)).toBe(true);
    if (captured?.kind !== 'bulk') throw new Error('Expected frozen parent');
    expect(Object.isFrozen(captured.body)).toBe(true);
    expect(Object.isFrozen(captured.body.items)).toBe(true);
    expect(Object.isFrozen(captured.body.items[0])).toBe(true);
    input.body.items.reverse();
    const mutatedItem = input.body.items[0];
    if (mutatedItem === undefined) throw new Error('Expected selected item');
    mutatedItem.expectedOrganizationRevision = 100;
    await act(() => f.result.current.start(single));
    expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(1);
    await act(() => f.result.current.retry());
    expect(vi.mocked(sendWorkflowOrganizationCommand).mock.calls[1]?.[1]).toBe(
      captured,
    );
    expect(captured.body.items).toEqual([
      { workflowId: secondWorkflowId, expectedOrganizationRevision: 4 },
      { workflowId, expectedOrganizationRevision: 7 },
    ]);
    act(() => {
      f.result.current.reset();
    });
    await act(() => f.result.current.start(single));
    expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(2);
    expect(f.result.current.retryAvailable).toBe(true);
    expect(f.result.current.result).toEqual(partial);
    await act(() => f.result.current.retry());
    expect(vi.mocked(sendWorkflowOrganizationCommand).mock.calls[2]?.[1]).toBe(
      captured,
    );
    expect(f.result.current.retryAvailable).toBe(false);
    act(() => {
      f.result.current.reset();
    });
    await act(() => f.result.current.start(single));
    expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(4);
  });

  it.each(['network', 'timeout', 'protocol', 'server'] as const)(
    'retains exact identity after uncertain %s transport failures',
    async (kind) => {
      const f = setup();
      vi.mocked(sendWorkflowOrganizationCommand).mockRejectedValueOnce(
        kind === 'server'
          ? new ApiError({ kind: 'problem', status: 503, message: 'private' })
          : new ApiError({ kind, message: 'private' }),
      );
      await act(() => f.result.current.start(single));
      expect(f.result.current.retryAvailable).toBe(true);
      expect(f.result.current.error).not.toContain('private');
      await act(() => f.result.current.retry());
      expect(
        vi.mocked(sendWorkflowOrganizationCommand).mock.calls[1]?.[1],
      ).toBe(vi.mocked(sendWorkflowOrganizationCommand).mock.calls[0]?.[1]);
    },
  );

  it('reauthorizes a retry from fresh discovery rather than cached role', async () => {
    const f = setup();
    vi.mocked(sendWorkflowOrganizationCommand).mockRejectedValueOnce(network());
    await act(() => f.result.current.start(single));
    vi.mocked(getAllAccessibleWorkspaces).mockResolvedValueOnce([
      { ...workspace, role: 'viewer' },
    ]);
    await act(() => f.result.current.retry());
    expect(f.result.current.denied).toBe(true);
    expect(f.result.current.retryAvailable).toBe(false);
    expect(f.result.current.result).toBeUndefined();
    expect(sendWorkflowOrganizationCommand).toHaveBeenCalledTimes(1);
  });

  it('ignores double submission and concurrent retry during authority/mutation work', async () => {
    const f = setup();
    const pending = deferred();
    vi.mocked(sendWorkflowOrganizationCommand).mockReturnValueOnce(
      pending.promise,
    );
    let first: Promise<void> | undefined;
    act(() => {
      first = f.result.current.start(single);
    });
    await waitFor(() => {
      expect(sendWorkflowOrganizationCommand).toHaveBeenCalledOnce();
    });
    expect(f.result.current.pending).toBe(true);
    await act(async () => {
      await f.result.current.start(single);
      await f.result.current.retry();
    });
    expect(sendWorkflowOrganizationCommand).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve(receipt);
      await first;
    });
  });

  it.each([401, 403, 404])(
    'retires mutation status %i rather than retrying stale authority',
    async (status) => {
      const f = setup();
      vi.mocked(sendWorkflowOrganizationCommand).mockRejectedValueOnce(
        new ApiError({ kind: 'problem', status, message: 'private' }),
      );
      await act(() => f.result.current.start(single));
      expect(f.result.current.denied).toBe(true);
      act(() => {
        f.result.current.reset();
      });
      await act(() => f.result.current.retry());
      expect(f.result.current.denied).toBe(true);
      expect(sendWorkflowOrganizationCommand).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'session',
    'cache-role',
    'cache-error',
    'scope',
    'unmount',
  ] as const)(
    'aborts %s ownership and never installs a late reply',
    async (event) => {
      const f = setup();
      const pending = deferred();
      vi.mocked(sendWorkflowOrganizationCommand).mockReturnValueOnce(
        pending.promise,
      );
      let task: Promise<void> | undefined;
      act(() => {
        task = f.result.current.start(single);
      });
      await waitFor(() => {
        expect(sendWorkflowOrganizationCommand).toHaveBeenCalledOnce();
      });
      const signal = vi.mocked(sendWorkflowOrganizationCommand).mock
        .calls[0]?.[2];
      act(() => {
        if (event === 'session') session.listener?.();
        if (event === 'cache-role')
          f.queryClient.setQueryData(
            ['identity', userId, 'accessible-workspaces'],
            [{ ...workspace, role: 'viewer' }],
          );
        if (event === 'cache-error') {
          const query = f.queryClient.getQueryCache().build(f.queryClient, {
            queryKey: workflowKeys.scope(userId, workspaceId),
          });
          query.setState({
            status: 'error',
            error: new ApiError({
              kind: 'problem',
              status: 403,
              message: 'private',
            }),
          });
        }
        if (event === 'scope')
          f.rerender({ ...f.props, userId: secondWorkflowId });
        if (event === 'unmount') f.unmount();
      });
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        pending.resolve(receipt);
        await task;
      });
      expect(f.result.current.result).toBeUndefined();
      if (
        event === 'session' ||
        event === 'cache-role' ||
        event === 'cache-error'
      )
        expect(f.result.current.denied).toBe(true);
    },
  );

  it('rejects role loss after acceptance before exposing a historical result', async () => {
    const f = setup();
    vi.mocked(getAllAccessibleWorkspaces)
      .mockResolvedValueOnce([workspace])
      .mockResolvedValueOnce([{ ...workspace, status: 'suspended' }]);
    await act(() => f.result.current.start(single));
    expect(f.result.current.denied).toBe(true);
    expect(f.result.current.result).toBeUndefined();
  });

  it('uses fixed conflict copy and permits a genuinely new intent without replaying the old key', async () => {
    const f = setup();
    vi.mocked(sendWorkflowOrganizationCommand).mockRejectedValueOnce(
      new ApiError({
        kind: 'problem',
        status: 409,
        message: 'private',
        problem: apiProblemSchema.parse({
          type: 'urn:pertexo:problem:workflow.folder_not_empty',
          title: 'Conflict',
          status: 409,
          code: 'workflow.folder_not_empty',
          detail: 'private-body',
          requestId: 'test-conflict',
        }),
      }),
    );
    await act(() => f.result.current.start(single));
    expect(f.result.current.error).toContain('child folders');
    expect(f.result.current.error).not.toContain('private');
    expect(f.result.current.retryAvailable).toBe(false);
    await act(() =>
      f.result.current.start({ ...single, idempotencyKey: 'new-intent' }),
    );
    expect(
      vi.mocked(sendWorkflowOrganizationCommand).mock.calls[1]?.[1]
        .idempotencyKey,
    ).toBe('new-intent');
  });

  it('rejects malformed or foreign attempts before any authority request or send', async () => {
    const f = setup();
    await act(() =>
      f.result.current.start({ ...single, workspaceId: secondWorkflowId }),
    );
    await act(() =>
      f.result.current.start({
        ...single,
        body: { folderId: null, expectedOrganizationRevision: 0 },
      }),
    );
    expect(assertSessionIdentity).not.toHaveBeenCalled();
    expect(sendWorkflowOrganizationCommand).not.toHaveBeenCalled();
    expect(f.result.current.error).toContain('invalid');
  });
});
