import { workflowKeys } from '@/features/workflows/data/workflows.queries';
import { workspaceKeys } from '@/features/workspaces/data/workspaces.queries';
import { ApiError } from '@/lib/api/error';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { secondWorkflowId, userId, workspaceId } from '../../list/fixtures';
import {
  deferred,
  problem,
  receipt,
  serveCommands,
  setup,
  signalSessionChange,
  single,
  workspace,
} from './fixture';

describe('ephemeral organization command lifetime', () => {
  it('reauthorizes a retry from fresh discovery rather than cached role', async () => {
    const server = serveCommands();
    server.answers.push('network');
    const f = setup();
    await act(() => f.result.current.start(single));
    server.discoveries = [[{ ...workspace, role: 'viewer' }]];
    await act(() => f.result.current.retry());
    expect(f.result.current.denied).toBe(true);
    expect(f.result.current.retryAvailable).toBe(false);
    expect(f.result.current.result).toBeUndefined();
    expect(server.sent).toHaveLength(1);
  });
  it('ignores double submission and concurrent retry during authority/mutation work', async () => {
    const server = serveCommands();
    const pending = deferred();
    server.answers.push(pending.answer);
    const f = setup();
    let first: Promise<void> | undefined;
    act(() => {
      first = f.result.current.start(single);
    });
    await waitFor(() => {
      expect(server.sent).toHaveLength(1);
    });
    expect(f.result.current.pending).toBe(true);
    await act(async () => {
      await f.result.current.start(single);
      await f.result.current.retry();
    });
    expect(server.sent).toHaveLength(1);
    await act(async () => {
      pending.release();
      await first;
    });
  });
  it.each([
    [401, 'auth.unauthenticated'],
    [403, 'auth.forbidden'],
    [404, 'resource.not_found'],
  ] as const)(
    'retires mutation status %i rather than retrying stale authority',
    async (status, code) => {
      const server = serveCommands();
      server.answers.push(problem(status, code));
      const f = setup();
      await act(() => f.result.current.start(single));
      expect(f.result.current.denied).toBe(true);
      act(() => {
        f.result.current.reset();
      });
      await act(() => f.result.current.retry());
      expect(f.result.current.denied).toBe(true);
      expect(server.sent).toHaveLength(1);
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
      const server = serveCommands();
      const pending = deferred();
      server.answers.push(pending.answer);
      const f = setup();
      let task: Promise<void> | undefined;
      act(() => {
        task = f.result.current.start(single);
      });
      await waitFor(() => {
        expect(server.sent).toHaveLength(1);
      });
      const signal = server.sent[0]?.signal;
      act(() => {
        if (event === 'session') signalSessionChange();
        if (event === 'cache-role')
          f.queryClient.setQueryData(workspaceKeys.accessible(userId), [
            { ...workspace, role: 'viewer' },
          ]);
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
        pending.release();
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
    serveCommands([[workspace], [{ ...workspace, status: 'suspended' }]]);
    const f = setup();
    await act(() => f.result.current.start(single));
    expect(f.result.current.denied).toBe(true);
    expect(f.result.current.result).toBeUndefined();
  });
  it('uses fixed conflict copy and permits a genuinely new intent without replaying the old key', async () => {
    const server = serveCommands();
    server.answers.push(
      problem(409, 'workflow.folder_not_empty', 'private-body'),
    );
    const f = setup();
    await act(() => f.result.current.start(single));
    expect(f.result.current.error).toContain('child folders');
    expect(f.result.current.error).not.toContain('private');
    expect(f.result.current.retryAvailable).toBe(false);
    await act(() =>
      f.result.current.start({ ...single, idempotencyKey: 'new-intent' }),
    );
    expect(server.sent.map(({ key }) => key)).toEqual([
      'single-key',
      'new-intent',
    ]);
    expect(f.result.current.result).toEqual(receipt);
  });
  it('rejects malformed or foreign attempts before any authority request or send', async () => {
    const server = serveCommands();
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
    expect(server.reads.identity).toBe(0);
    expect(server.sent).toHaveLength(0);
    expect(f.result.current.error).toContain('invalid');
  });
});
