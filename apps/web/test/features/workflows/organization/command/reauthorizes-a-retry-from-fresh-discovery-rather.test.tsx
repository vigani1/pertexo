import { workflowKeys } from '@/features/workflows/data/workflows.queries';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { secondWorkflowId, userId, workspaceId } from '../../list/fixtures';
import {
  deferred,
  problem,
  receipt,
  serveCommands,
  setup,
  single,
  workspaceAs,
} from './fixture';

describe('server-authoritative organization changes', () => {
  it('uses the current control capability and never preflights discovery', async () => {
    const server = serveCommands();
    const f = setup();
    f.rerender({ ...f.props, workspace: workspaceAs('viewer') });
    await act(() => f.result.current.start(single));
    expect(f.result.current.denied).toBe(true);
    expect(server.sent).toHaveLength(0);
    expect(server.reads).toEqual({ identity: 0, discovery: 0 });
  });
  it('ignores a second submission while the first is pending', async () => {
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
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(1);
    await act(async () => {
      pending.release();
      await first;
    });
    await waitFor(() => {
      expect(f.result.current.result).toEqual(receipt);
    });
  });
  it.each([
    [401, 'auth.unauthenticated'],
    [403, 'auth.forbidden'],
    [404, 'resource.not_found'],
  ] as const)(
    'shows the server’s %i refusal without treating it as a read result',
    async (status, code) => {
      const server = serveCommands();
      server.answers.push(problem(status, code));
      const f = setup();
      const key = workflowKeys.scope(userId, workspaceId);
      const snapshot = { workflows: [] };
      f.queryClient.setQueryData(key, snapshot);
      await act(() => f.result.current.start(single));
      expect(server.sent).toHaveLength(1);
      expect(server.reads).toEqual({ identity: 0, discovery: 0 });
      expect(f.result.current.result).toBeUndefined();
      await waitFor(() => {
        expect(f.result.current.error).toBeDefined();
      });
      expect(f.result.current.error).not.toContain('private');
      expect(f.queryClient.getQueryData(key)).toEqual(snapshot);
      expect(f.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    },
  );
  it('does not expose a late receipt to an unmounted caller', async () => {
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
    f.unmount();
    await act(async () => {
      pending.release();
      await task;
    });
    expect(f.result.current.result).toBeUndefined();
  });
  it('keeps specific conflict feedback and gives a new confirmation a fresh key', async () => {
    const server = serveCommands();
    server.answers.push(
      problem(409, 'workflow.folder_not_empty', 'private-body'),
    );
    const f = setup();
    await act(() => f.result.current.start(single));
    await waitFor(() => {
      expect(f.result.current.error).toContain('child folders');
    });
    expect(f.result.current.error).not.toContain('private');
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(2);
    expect(server.sent[0]?.key).not.toBe(server.sent[1]?.key);
    await waitFor(() => {
      expect(f.result.current.result).toEqual(receipt);
    });
  });
  it('rejects foreign scopes and malformed input before sending a request', async () => {
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
    await waitFor(() => {
      expect(f.result.current.error).toBeDefined();
    });
  });
});
