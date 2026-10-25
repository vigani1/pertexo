import { assertSessionIdentity } from '@/features/auth/session/identity.public';
import { resetCommandMocks } from './setup';

import { sendWorkflowOrganizationCommand } from '@/features/workflows/data/organization/api';

import { workflowKeys } from '@/features/workflows/data/workflows.queries';

import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';

import { ApiError } from '@/lib/api/error';

import { apiProblemSchema } from '@pertexo/contracts';

import { act, waitFor } from '@testing-library/react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { secondWorkflowId, userId, workspaceId } from '../../list/fixtures';

import {
  deferred,
  network,
  receipt,
  session,
  setup,
  single,
  workspace,
} from './fixture';

vi.mock('@/features/auth/session/sync.public', () => ({
  subscribeSessionChanges: (listener: () => void) => {
    session.listener = listener;
    return session.unsubscribe;
  },
}));

vi.mock('@/features/auth/session/identity.public', async (original) => ({
  ...(await original<object>()),
  assertSessionIdentity: vi.fn(),
}));

vi.mock('@/features/workspaces/queries.public', () => ({
  getAllAccessibleWorkspaces: vi.fn(),
}));

vi.mock('@/features/workflows/data/organization/api', async (original) => ({
  ...(await original<object>()),
  sendWorkflowOrganizationCommand: vi.fn(),
}));

beforeEach(resetCommandMocks);

describe('ephemeral organization command lifetime', () => {
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
