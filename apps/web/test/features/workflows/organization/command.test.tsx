import { workflowOrganizationKeys } from '@/features/workflows/data/organization/workflow-organization.queries';
import { workflowKeys } from '@/features/workflows/data/workflows.queries';
import { ApiError } from '@/lib/api/error';
import { act, waitFor } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  secondWorkflowId,
  userId,
  workflowId,
  workspaceId,
} from '../list/fixtures';
import {
  bulk,
  deferred,
  partial,
  problem,
  receipt,
  serveCommands,
  setup,
  single,
  workspaceAs,
} from './command/fixture';

describe('low-effect organization mutations', () => {
  it.each([
    { requiredRole: 'member', role: 'owner', accepted: true },
    { requiredRole: 'member', role: 'admin', accepted: true },
    { requiredRole: 'member', role: 'builder', accepted: true },
    { requiredRole: 'member', role: 'operator', accepted: true },
    { requiredRole: 'member', role: 'viewer', accepted: true },
    { requiredRole: 'editor', role: 'owner', accepted: true },
    { requiredRole: 'editor', role: 'admin', accepted: true },
    { requiredRole: 'editor', role: 'builder', accepted: true },
    { requiredRole: 'editor', role: 'operator', accepted: false },
    { requiredRole: 'editor', role: 'viewer', accepted: false },
    { requiredRole: 'admin', role: 'owner', accepted: true },
    { requiredRole: 'admin', role: 'admin', accepted: true },
    { requiredRole: 'admin', role: 'builder', accepted: false },
    { requiredRole: 'admin', role: 'operator', accepted: false },
    { requiredRole: 'admin', role: 'viewer', accepted: false },
  ] as const)(
    'uses the active $requiredRole control for $role',
    async ({ requiredRole, role, accepted }) => {
      const current = workspaceAs(role);
      const server = serveCommands([[current]]);
      const f = setup({ workspace: current, requiredRole });
      await act(() => f.result.current.start(single));
      expect(server.sent).toHaveLength(accepted ? 1 : 0);
      expect(f.result.current.denied).toBe(!accepted);
    },
  );

  it('keeps ordered partial outcomes as feedback and refreshes current state without retaining a parent resend', async () => {
    const server = serveCommands();
    server.answers.push(HttpResponse.json(partial));
    const f = setup();
    const key = workflowOrganizationKeys.scope(userId, workspaceId);
    const current = { revision: 99 };
    f.queryClient.setQueryData(key, current);
    await act(() => f.result.current.start(bulk()));
    await waitFor(() => {
      expect(f.result.current.result).toEqual(partial);
    });
    expect(f.queryClient.getQueryData(key)).toEqual(current);
    expect(f.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(2);
    expect(server.sent[1]?.key).not.toBe(server.sent[0]?.key);
    expect(server.sent[1]?.body).toEqual(single.body);
  });
  it('keeps forbidden and unprocessed feedback in response order', async () => {
    const server = serveCommands();
    const result = {
      items: [
        { workflowId: secondWorkflowId, status: 'forbidden' },
        { workflowId, status: 'not_processed' },
      ],
    };
    server.answers.push(HttpResponse.json(result));
    const f = setup();
    await act(() => f.result.current.start(bulk()));
    await waitFor(() => {
      expect(f.result.current.result).toEqual(result);
    });
    expect(f.result.current.denied).toBe(true);
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(1);
  });
  it('does not turn an unrelated read denial into organization authority', async () => {
    const server = serveCommands();
    const f = setup();
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
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(1);
    await waitFor(() => {
      expect(f.result.current.result).toEqual(receipt);
    });
    expect(f.result.current.denied).toBe(false);
  });
  it('blocks a second intent and reset while pending, then permits a new confirmation with a fresh key', async () => {
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
    act(() => {
      f.result.current.reset();
    });
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(1);
    expect(f.result.current.pending).toBe(true);
    await act(async () => {
      pending.release();
      await first;
    });
    await waitFor(() => {
      expect(f.result.current.pending).toBe(false);
    });
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(2);
    expect(server.sent[1]?.key).not.toBe(server.sent[0]?.key);
  });
  it('invalidates both current scopes without projecting a historical receipt or making authority preflights', async () => {
    const server = serveCommands();
    const f = setup();
    const key = workflowOrganizationKeys.detail(
      userId,
      workspaceId,
      workflowId,
      { include: 'organization' },
    );
    const legacy = workflowKeys.detail(userId, workspaceId, workflowId);
    const current = { organizationRevision: 99, folderId: secondWorkflowId };
    f.queryClient.setQueryData(key, current);
    f.queryClient.setQueryData(legacy, current);
    await act(() => f.result.current.start(single));
    await waitFor(() => {
      expect(f.result.current.result).toEqual(receipt);
    });
    for (const read of [key, legacy]) {
      expect(f.queryClient.getQueryData(read)).toEqual(current);
      expect(f.queryClient.getQueryState(read)?.isInvalidated).toBe(true);
    }
    expect(server.reads).toEqual({ identity: 0, discovery: 0 });
  });
  it.each([
    ['a lost connection', 'network' as const],
    ['an unreadable reply', HttpResponse.text('{', { status: 200 })],
    ['a 503', problem(503, 'service.unavailable')],
  ])(
    'refreshes after %s and gives a new confirmation its own key',
    async (_name, failure) => {
      const server = serveCommands();
      server.answers.push(failure);
      const f = setup();
      const key = workflowKeys.scope(userId, workspaceId);
      f.queryClient.setQueryData(key, { workflows: [] });
      await act(() => f.result.current.start(single));
      await waitFor(() => {
        expect(f.result.current.error).toContain(
          'Check the refreshed current state',
        );
      });
      expect(f.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
      await act(() => f.result.current.start(single));
      expect(server.sent).toHaveLength(2);
      expect(server.sent[1]?.key).not.toBe(server.sent[0]?.key);
      expect(server.sent[1]?.body).toEqual(server.sent[0]?.body);
    },
  );
});
