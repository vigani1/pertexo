import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceInvitation, WorkspaceMember } from '@pertexo/contracts';
import { expect, it } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { useAutoPauseCommand } from '@/features/workflow-settings/data/mutations/use-auto-pause-command';
import { useInputCases } from '@/features/workflows/hooks/use-input-cases';
import { useMemberRemovalCommand } from '@/features/workspaces/data/mutations/members/use-removal-command';
import { useInvitationCommand } from '@/features/workspaces/data/mutations/use-invitation-command';
import { invitation } from '../../features/workspaces/members/fixture';
import {
  firstMemberId,
  member,
  secondMemberId,
  userId,
  workspaceId,
} from '../../support/fixtures/team';

// Each hook changes several targets and keeps one held key per target. A
// change whose answer was lost must keep its key while another target is
// changed, so resending it later replays the server's receipt instead of
// applying it a second time.
const workflowId = '99999999-9999-4999-8999-999999999999';

type Sent = Readonly<{ method: string; path: string; key: string | null }>;

function lostAnswers() {
  const sent: Sent[] = [];
  const apiClient = createApiClient({
    readCsrfToken: () => 'csrf-token-1234567890',
    fetch: (url, init) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET')
        sent.push({
          method,
          path: new URL(
            url instanceof Request ? url.url : url,
            'http://pertexo.test',
          ).pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        });
      return Promise.reject(new TypeError('Failed to fetch'));
    },
  });
  return { apiClient, sent };
}

function render<Result>(hook: () => Result) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return renderHook(hook, {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }).result;
}

/** Sends A, then B, then A again, every answer lost; returns the keys. */
async function aThenBThenA(
  sent: Sent[],
  send: (target: 'a' | 'b') => Promise<unknown>,
) {
  for (const target of ['a', 'b', 'a'] as const)
    await act(async () => {
      await send(target);
    });
  expect(sent).toHaveLength(3);
  const [firstA, b, secondA] = sent;
  expect(secondA?.path).toBe(firstA?.path);
  expect(b?.path).not.toBe(firstA?.path);
  return { firstA: firstA?.key, b: b?.key, secondA: secondA?.key };
}

function expectReplayed(keys: Awaited<ReturnType<typeof aThenBThenA>>) {
  expect(keys.firstA).toEqual(expect.any(String));
  expect(keys.b).not.toBe(keys.firstA);
  expect(keys.secondA).toBe(keys.firstA);
}

it('keeps a lost member removal’s key while another member is removed', async () => {
  const { apiClient, sent } = lostAnswers();
  const members = {
    a: member(firstMemberId, 'Ada', 'builder') as WorkspaceMember,
    b: member(secondMemberId, 'Bea', 'builder') as WorkspaceMember,
  };
  const result = render(() =>
    useMemberRemovalCommand({
      apiClient,
      actorUserId: userId,
      workspaceId,
      onRemoved: () => undefined,
      onConflict: () => undefined,
      onTargetUnavailable: () => undefined,
    }),
  );
  expectReplayed(
    await aThenBThenA(sent, (target) => result.current.start(members[target])),
  );
});

it('keeps a lost invitation revocation’s key while another is revoked', async () => {
  const { apiClient, sent } = lostAnswers();
  const invitations = {
    a: invitation('ada@example.test') as WorkspaceInvitation,
    b: invitation(
      'bea@example.test',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ) as WorkspaceInvitation,
  };
  const result = render(() =>
    useInvitationCommand({
      apiClient,
      userId,
      workspaceId,
      onPermissionLost: () => undefined,
    }),
  );
  expectReplayed(
    await aThenBThenA(sent, (target) =>
      result.current.change(invitations[target], 'revoke'),
    ),
  );
});

it('keeps a lost input-case delete’s key while another case is deleted', async () => {
  const { apiClient, sent } = lostAnswers();
  const caseIds = {
    a: '11111111-1111-4111-8111-111111111111',
    b: '22222222-2222-4222-8222-222222222222',
  };
  const result = render(() =>
    useInputCases({
      api: apiClient,
      userId,
      workspaceId,
      workflowId,
      canWrite: true,
    }),
  );
  expectReplayed(
    await aThenBThenA(sent, (target) =>
      result.current.send({
        command: { kind: 'delete', caseId: caseIds[target], tag: '"1"' },
      }),
    ),
  );
});

it('keeps a lost workflow auto-pause save’s key while workspace settings are saved', async () => {
  const { apiClient, sent } = lostAnswers();
  const result = render(() =>
    useAutoPauseCommand(apiClient, userId, workspaceId, workflowId),
  );
  expectReplayed(
    await aThenBThenA(sent, (target) =>
      result.current.send(
        target === 'a'
          ? {
              kind: 'workflow',
              body: {
                enabled: true,
                thresholdOverride: null,
                expectedSettingsRevision: 1,
              },
            }
          : {
              kind: 'workspace',
              body: { threshold: 5, expectedRevision: 1 },
            },
      ),
    ),
  );
});
