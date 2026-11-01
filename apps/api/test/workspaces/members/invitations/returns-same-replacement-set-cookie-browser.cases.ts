import { toProblem } from '../../../../src/problems/registry.js';
import { workspaceFailure } from '../../../../src/problems/context/normalize.js';
import { expect, it, vi } from 'vitest';
import { InvitationAcceptanceConflictError } from '@pertexo/core/tenant-access';
import {
  DoubleSubmitCsrfPolicy,
  IdentityError,
  nodeIdentityCrypto,
} from '../../../../src/identity/index.js';
import {
  InvitationAcceptanceController,
  type CookieResponse,
  type IdentityWorkspaceRequest,
  type IdentitySessionAuthority,
} from '../../../../src/workspaces/index.js';
import type { InvitationAcceptanceResolvePersistenceInput } from '../../../../src/workspaces/ports.js';
import {
  workspaceId,
  invitationId,
  intentId,
  actorId,
  now,
  pendingIntent,
  acceptanceUseCase,
} from './fixture.js';

export function registerReturnsSameReplacementSetCookieBrowser(): void {
  it('returns the same replacement Set-Cookie when the browser retries with its stale binding', async () => {
    const resolveInvitationAcceptance = vi.fn(
      (input: InvitationAcceptanceResolvePersistenceInput) =>
        Promise.resolve({
          id: input.intentId,
          workspaceId,
          invitationId,
          invitationRevision: 1,
          status: 'pending' as const,
          expiresAt: new Date('2026-09-19T12:15:00.000Z'),
          verifiedUserId: null,
          verifiedSessionId: null,
          verifiedEmail: null,
          verifiedAt: null,
          workspaceName: 'Control Operations',
          invitationRole: 'viewer' as const,
          invitationStatus: 'pending' as const,
          acceptedUserId: null,
          receipt: null,
        }),
    );
    const useCase = acceptanceUseCase({ resolveInvitationAcceptance });
    const controller = new InvitationAcceptanceController(
      useCase,
      {} as IdentitySessionAuthority,
      new DoubleSubmitCsrfPolicy(nodeIdentityCrypto),
      { secure: true, sameSite: 'lax' },
      'https://web.example.test',
    );
    const token = `wi1.${workspaceId}.${invitationId}.${'a'.repeat(43)}`;
    const priorBinding = `wb1.${workspaceId}.${intentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`;
    const request = {
      headers: {
        origin: 'https://web.example.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      cookies: { pertexo_invitation_intent: priorBinding },
    } satisfies IdentityWorkspaceRequest;
    let firstCookie: string | readonly string[] | undefined;
    let retryCookie: string | readonly string[] | undefined;
    const firstResponse: CookieResponse = {
      header: (name, value) => {
        if (name === 'set-cookie') firstCookie = value;
      },
    };
    const retryResponse: CookieResponse = {
      header: (name, value) => {
        if (name === 'set-cookie') retryCookie = value;
      },
    };

    const first = await controller.resolve(request, { token }, firstResponse);
    const retry = await controller.resolve(request, { token }, retryResponse);

    expect(retry).toEqual(first);
    expect(retryCookie).toBe(firstCookie);
    expect(String(retryCookie)).toMatch(
      /^pertexo_invitation_intent=wb1\..+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=900$/u,
    );
  });

  it('reports an abandoned bound journey as unavailable', async () => {
    const useCase = acceptanceUseCase({
      readInvitationAcceptance: vi.fn().mockResolvedValue({
        ...pendingIntent(),
        status: 'abandoned',
      }),
    });
    const binding = `wb1.${workspaceId}.${intentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`;

    await expect(useCase.read(binding)).resolves.toEqual({
      state: 'unavailable',
    });
  });

  it('maps expired recipient proof separately from other invitation conflicts', () => {
    expect(
      toProblem(
        workspaceFailure(
          new InvitationAcceptanceConflictError(
            'proof_expired',
            'Fresh recipient verification is required',
          ),
        ),
      ),
    ).toMatchObject({
      code: 'workspace.invitation_proof_expired',
      safeDetail: 'Verify the invited account again before accepting.',
    });
  });

  it('requires same-user sign-in before disclosing a completed bound receipt', async () => {
    const readInvitationAcceptance = vi.fn().mockResolvedValue({
      id: intentId,
      workspaceId,
      invitationId,
      invitationRevision: 1,
      status: 'completed',
      expiresAt: new Date('2026-09-19T12:15:00.000Z'),
      verifiedUserId: actorId,
      verifiedSessionId: null,
      verifiedEmail: 'recipient@example.test',
      verifiedAt: now,
      workspaceName: 'Control Operations',
      invitationRole: 'viewer',
      invitationStatus: 'accepted',
      acceptedUserId: actorId,
      receipt: {
        intentId,
        workspaceId,
        role: 'viewer',
        membershipCreated: true,
      },
    });
    const useCase = acceptanceUseCase({ readInvitationAcceptance });
    const binding = `wb1.${workspaceId}.${intentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`;

    await expect(useCase.read(binding)).resolves.toMatchObject({
      state: 'sign_in_required',
      intentId,
    });
    await expect(useCase.read(binding, actorId)).resolves.toMatchObject({
      state: 'completed',
      intentId,
      membershipCreated: true,
    });
  });

  it('installs the Better Auth replacement session with the acceptance', async () => {
    const completeInvitationAcceptance = vi.fn().mockResolvedValue({
      intentId,
      workspaceId,
      role: 'viewer',
      membershipCreated: true,
      replayed: false,
      replacementSessionCreated: true,
    });
    const useCase = acceptanceUseCase({
      readInvitationAcceptance: vi.fn().mockResolvedValue({
        ...pendingIntent(),
        status: 'verified',
        verifiedUserId: actorId,
        verifiedSessionId: null,
        verifiedEmail: 'recipient@example.test',
        verifiedAt: now,
      }),
      completeInvitationAcceptance,
    });

    const result = await useCase.complete({
      binding: `wb1.${workspaceId}.${intentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`,
      csrfToken: 'c'.repeat(43),
      authenticatedUserId: actorId,
      request: { intentId, expectedRevision: 1 },
      idempotencyKey: 'invitation-accept',
      userAgent: 'acceptance-test',
    });

    const token = result.replacementToken ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.replacementExpiresAt).toEqual(
      new Date(now.getTime() + 60_000),
    );
    const [command] = completeInvitationAcceptance.mock.calls[0] as [
      { replacementSession: Record<string, unknown> },
    ];
    expect(command.replacementSession).toEqual({
      id: expect.any(String) as string,
      token,
      expiresAt: new Date(now.getTime() + 60_000),
      userAgent: 'acceptance-test',
    });
  });

  it('rejects a sign-in whose email is not verified as recipient proof', async () => {
    const useCase = acceptanceUseCase({
      readInvitationAcceptance: vi.fn().mockResolvedValue(pendingIntent()),
    });
    await expect(
      useCase.recordSessionProof({
        binding: `wb1.${workspaceId}.${intentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`,
        csrfToken: 'c'.repeat(43),
        evidence: {
          userId: actorId,
          email: 'recipient@example.test',
          emailVerified: false,
          signedInAt: now,
          sessionId: actorId,
        },
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });
}
