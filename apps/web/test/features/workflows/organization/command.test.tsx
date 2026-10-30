import { currentUserQueryKey } from '@/features/auth/data/auth.queries';
import { workflowOrganizationKeys } from '@/features/workflows/data/organization/queries';
import { workflowKeys } from '@/features/workflows/data/workflows.queries';
import { ApiError } from '@/lib/api/error';
import { act, waitFor } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  secondWorkflowId,
  user,
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
  signalSessionChange,
  single,
  workspace,
  workspaceAs,
} from './command/fixture';

describe('ephemeral organization command lifetime', () => {
  // Organizing needs a member, an editor (owner, admin or builder) or an
  // admin (owner or admin), checked against the server's current answer.
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
    'requires fresh active $requiredRole authority for $role',
    async ({ requiredRole, role, accepted }) => {
      const current = workspaceAs(role);
      const server = serveCommands([[current]]);
      const f = setup({ workspace: current, requiredRole });
      await act(() => f.result.current.start(single));
      expect(server.sent).toHaveLength(accepted ? 1 : 0);
      expect(f.result.current.denied).toBe(!accepted);
    },
  );
  it('retains ordered public forbidden feedback but retires its private attempt', async () => {
    const server = serveCommands();
    const response = {
      items: [
        { workflowId: secondWorkflowId, status: 'forbidden' as const },
        { workflowId, status: 'not_processed' as const },
      ],
    };
    server.answers.push(HttpResponse.json(response));
    const f = setup();
    await act(() => f.result.current.start(bulk()));
    expect(f.result.current.result).toEqual(response);
    expect(f.result.current.denied).toBe(true);
    expect(f.result.current.retryAvailable).toBe(false);
    await act(async () => {
      await f.result.current.retry();
      await f.result.current.start(single);
    });
    expect(server.sent).toHaveLength(1);
    act(() => {
      signalSessionChange();
    });
    expect(f.result.current.result).toBeUndefined();
  });
  it('does not retire from an unrelated feature denial, but observes identity changes', async () => {
    const server = serveCommands();
    server.answers.push('network');
    const f = setup();
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
      f.queryClient.setQueryData(currentUserQueryKey, {
        ...user,
        id: secondWorkflowId,
      });
    });
    expect(f.result.current.denied).toBe(true);
    expect(f.result.current.retryAvailable).toBe(false);
  });
  it('requires fresh read capability and clears only sibling organization caches on access loss', async () => {
    const server = serveCommands([[{ ...workspace, capabilities: [] }]]);
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
    await act(() => f.result.current.start(single));
    expect(f.result.current.denied).toBe(true);
    expect(server.sent).toHaveLength(0);
    expect(f.queryClient.getQueryData(organization)).toBeUndefined();
    expect(f.queryClient.getQueryData(unrelated)).toEqual({
      exactRecovery: true,
    });
    expect(
      f.queryClient.getQueryData(workflowKeys.scope(userId, workspaceId)),
    ).toEqual({ currentWorkflow: true });
  });
  it('preserves exact whole-parent recovery when an item outcome is unknown', async () => {
    const server = serveCommands();
    const response = {
      items: [
        {
          workflowId: secondWorkflowId,
          status: 'outcome_unknown' as const,
        },
        {
          workflowId,
          status: 'updated' as const,
          organizationRevision: 8,
          replayed: true,
        },
      ],
    };
    server.answers.push(
      HttpResponse.json(response),
      HttpResponse.json(response),
    );
    const f = setup();
    await act(() => f.result.current.start(bulk()));
    expect(f.result.current.retryAvailable).toBe(true);
    await act(() => f.result.current.retry());
    expect(server.sent).toHaveLength(2);
    expect(server.sent[1]?.key).toBe(server.sent[0]?.key);
    expect(server.sent[1]?.body).toEqual(server.sent[0]?.body);
  });
  it('does not reset an outstanding command or release a different intent before its known result', async () => {
    const server = serveCommands();
    const older = deferred(),
      newer = deferred({ ...receipt, organizationRevision: 9 });
    server.answers.push(older.answer, newer.answer);
    const f = setup();
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    act(() => {
      first = f.result.current.start(single);
    });
    await waitFor(() => {
      expect(server.sent).toHaveLength(1);
    });
    act(() => {
      f.result.current.reset();
      second = f.result.current.start({ ...single, idempotencyKey: 'new-key' });
    });
    expect(server.sent).toHaveLength(1);
    expect(f.result.current.pending).toBe(true);
    expect(server.sent[0]?.signal.aborted).toBe(false);
    await act(async () => {
      older.release();
      await first;
    });
    expect(f.result.current.pending).toBe(false);
    expect(f.result.current.result).toEqual(receipt);
    act(() => {
      f.result.current.reset();
      second = f.result.current.start({ ...single, idempotencyKey: 'new-key' });
    });
    await waitFor(() => {
      expect(server.sent).toHaveLength(2);
    });
    expect(server.sent[1]?.key).toBe('new-key');
    await act(async () => {
      newer.release();
      await second;
    });
    expect(f.result.current.result).toEqual({
      ...receipt,
      organizationRevision: 9,
    });
  });
  it('invalidates both current sibling scopes without projecting historical receipt revisions', async () => {
    const server = serveCommands();
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
    // Who is signed in and what they may do is read fresh before the
    // command and again before its result is shown.
    expect(server.reads).toEqual({ identity: 2, discovery: 2 });
  });
  it('retains the entire unresolved parent through reset and permits a new intent only after definitive recovery', async () => {
    const server = serveCommands();
    server.answers.push(
      HttpResponse.json(partial),
      HttpResponse.json(partial),
      HttpResponse.json({
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
      }),
    );
    const f = setup();
    const input = bulk();
    const sentBody = bulk().body;
    await act(() => f.result.current.start(input));
    expect(f.result.current.retryAvailable).toBe(true);
    expect(f.result.current.result).toEqual(partial);
    // Changing the caller's selection afterwards can't change the retry.
    input.body.items.reverse();
    const mutatedItem = input.body.items[0];
    if (mutatedItem === undefined) throw new Error('Expected selected item');
    mutatedItem.expectedOrganizationRevision = 100;
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(1);
    await act(() => f.result.current.retry());
    act(() => {
      f.result.current.reset();
    });
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(2);
    expect(f.result.current.retryAvailable).toBe(true);
    expect(f.result.current.result).toEqual(partial);
    await act(() => f.result.current.retry());
    expect(f.result.current.retryAvailable).toBe(false);
    expect(server.sent.map(({ key, body }) => ({ key, body }))).toEqual([
      { key: 'whole-parent-key', body: sentBody },
      { key: 'whole-parent-key', body: sentBody },
      { key: 'whole-parent-key', body: sentBody },
    ]);
    act(() => {
      f.result.current.reset();
    });
    await act(() => f.result.current.start(single));
    expect(server.sent).toHaveLength(4);
    expect(server.sent[3]?.key).toBe('single-key');
  });
  it.each([
    ['a lost connection', 'network' as const],
    ['an unreadable reply', HttpResponse.text('{', { status: 200 })],
    ['a 503', problem(503, 'service.unavailable')],
  ])('retains exact identity after %s', async (_name, failure) => {
    const server = serveCommands();
    server.answers.push(failure);
    const f = setup();
    await act(() => f.result.current.start(single));
    expect(f.result.current.retryAvailable).toBe(true);
    expect(f.result.current.error).not.toContain('private');
    await act(() => f.result.current.retry());
    expect(server.sent).toHaveLength(2);
    expect(server.sent[1]?.key).toBe(server.sent[0]?.key);
    expect(server.sent[1]?.body).toEqual(server.sent[0]?.body);
  });
});
