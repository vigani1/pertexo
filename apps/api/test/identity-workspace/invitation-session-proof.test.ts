import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  DoubleSubmitCsrfPolicy,
  nodeIdentityCrypto,
  type SignInEvidence,
} from '../../src/identity/index.js';
import {
  BetterAuthSessionService,
  type BetterAuthRuntime,
} from '../../src/identity-infrastructure/index.js';
import {
  InvitationAcceptanceController,
  InvitationAcceptanceUseCase,
  type CookieResponse,
  type IdentitySessionAuthority,
} from '../../src/identity-workspace/index.js';
import type { InvitationAcceptanceIntentPersistenceRecord } from '../../src/identity-workspace/ports.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const invitationId = '22222222-2222-4222-8222-222222222222';
const intentId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-09-24T12:00:00.000Z');
const bindingSecret = 'b'.repeat(43);
const csrfToken = 'c'.repeat(43);
const binding = `wb1.${workspaceId}.${intentId}.${bindingSecret}.${csrfToken}`;

function intent(
  status: InvitationAcceptanceIntentPersistenceRecord['status'],
): InvitationAcceptanceIntentPersistenceRecord {
  return {
    id: intentId,
    workspaceId,
    invitationId,
    invitationRevision: 1,
    status,
    expiresAt: new Date('2026-09-24T12:15:00.000Z'),
    verifiedUserId: status === 'pending' ? null : userId,
    verifiedEmail: null,
    verifiedAt: null,
    workspaceName: 'Northwind Ops',
    invitationRole: 'viewer',
    invitationStatus: 'pending',
    acceptedUserId: null,
    receipt: null,
  };
}

function evidence(overrides: Partial<SignInEvidence> = {}): SignInEvidence {
  return {
    userId,
    email: 'Recipient@Example.test',
    emailVerified: true,
    signedInAt: new Date(now.getTime() - 60_000),
    ...overrides,
  };
}

function useCase(recorded = intent('verified')) {
  const recordInvitationAcceptanceProof = vi.fn().mockResolvedValue(recorded);
  const acceptance = new InvitationAcceptanceUseCase(
    {
      resolveInvitationAcceptance: vi.fn(),
      readInvitationAcceptance: vi.fn().mockResolvedValue(intent('pending')),
      recordInvitationAcceptanceProof,
      completeInvitationAcceptance: vi.fn(),
      abandonInvitationAcceptance: vi.fn(),
    },
    undefined,
    nodeIdentityCrypto,
    { now: () => now },
    { publicWebOrigin: 'https://app.example.test' },
    { replacementCredential: vi.fn() },
  );
  return { acceptance, recordInvitationAcceptanceProof };
}

describe('invitation acceptance under the active session authority', () => {
  it('records a fresh verified sign-in as the bound recipient proof', async () => {
    const { acceptance, recordInvitationAcceptanceProof } = useCase();
    await expect(
      acceptance.recordSessionProof({
        binding,
        csrfToken,
        evidence: evidence(),
      }),
    ).resolves.toMatchObject({
      state: 'ready',
      intentId,
      workspace: { id: workspaceId, name: 'Northwind Ops' },
      role: 'viewer',
      sessionRotationRequired: true,
    });
    expect(recordInvitationAcceptanceProof).toHaveBeenCalledWith({
      workspaceId,
      intentId,
      bindingDigest: createHash('sha256').update(bindingSecret).digest('hex'),
      userId,
      verifiedEmail: 'Recipient@Example.test',
      verifiedAt: new Date(now.getTime() - 60_000),
    });
  });

  it('reports a different signed-in account without accepting', async () => {
    const { acceptance } = useCase(intent('wrong_account'));
    await expect(
      acceptance.recordSessionProof({
        binding,
        csrfToken,
        evidence: evidence(),
      }),
    ).resolves.toMatchObject({ state: 'wrong_account' });
  });

  it.each([
    [
      'an unverified email',
      evidence({ emailVerified: false }),
      { code: 'identity.callback_rejected' },
    ],
    [
      'a sign-in older than five minutes',
      evidence({ signedInAt: new Date(now.getTime() - 5 * 60_000 - 1) }),
      { reason: 'proof_expired' },
    ],
  ])('refuses %s', async (_case, stale, failure) => {
    const { acceptance, recordInvitationAcceptanceProof } = useCase();
    await expect(
      acceptance.recordSessionProof({ binding, csrfToken, evidence: stale }),
    ).rejects.toMatchObject(failure);
    expect(recordInvitationAcceptanceProof).not.toHaveBeenCalled();
  });

  it('fails closed on a wrong CSRF token, a vanished intent and a missing OIDC path', async () => {
    const { acceptance } = useCase(null as never);
    await expect(
      acceptance.recordSessionProof({
        binding,
        csrfToken: 'd'.repeat(43),
        evidence: evidence(),
      }),
    ).rejects.toMatchObject({ code: 'identity.csrf_failed' });
    await expect(
      acceptance.recordSessionProof({
        binding,
        csrfToken,
        evidence: evidence(),
      }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(
      acceptance.startOidc(binding, csrfToken),
    ).rejects.toMatchObject({ code: 'identity.provider_unavailable' });
  });

  it('asks the session authority for evidence of the authenticated user only', async () => {
    const recordSessionProof = vi.fn().mockResolvedValue({ state: 'ready' });
    const controllerWith = (sessions: Partial<IdentitySessionAuthority>) =>
      new InvitationAcceptanceController(
        { recordSessionProof } as unknown as InvitationAcceptanceUseCase,
        sessions as IdentitySessionAuthority,
        new DoubleSubmitCsrfPolicy(nodeIdentityCrypto),
        { secure: true, sameSite: 'lax' },
        'https://app.example.test',
      );
    const response: CookieResponse = { header: vi.fn() };
    const request = {
      headers: {
        cookie: `pertexo_session=session-cookie; pertexo_invitation_intent=${binding}`,
        'x-invitation-csrf-token': csrfToken,
      },
      identitySession: {
        userId,
        sessionId: '55555555-5555-4555-8555-555555555555',
        expiresAt: new Date('2026-09-25T00:00:00.000Z'),
        clientMetadata: {},
      },
    };
    const signInEvidence = vi.fn().mockResolvedValue(evidence());

    await expect(
      controllerWith({}).verifySession(request, {}, response),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    await expect(
      controllerWith({
        signInEvidence: vi
          .fn()
          .mockResolvedValue(evidence({ userId: invitationId })),
      }).verifySession(request, {}, response),
    ).rejects.toMatchObject({ code: 'auth.unauthenticated' });
    await expect(
      controllerWith({ signInEvidence }).verifySession(
        request,
        { extra: true },
        response,
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      controllerWith({ signInEvidence }).verifySession(request, {}, response),
    ).resolves.toEqual({ state: 'ready' });
    expect(signInEvidence).toHaveBeenCalledWith('session-cookie');
    expect(recordSessionProof).toHaveBeenCalledWith({
      binding,
      csrfToken,
      evidence: evidence(),
    });
  });

  it('derives Better Auth evidence from the live database session', async () => {
    const evidenceLookup = vi
      .fn()
      .mockResolvedValueOnce(evidence())
      .mockResolvedValueOnce(undefined);
    const sessions = new BetterAuthSessionService(
      {
        sessions: { evidence: evidenceLookup },
      } as unknown as BetterAuthRuntime,
      { secure: true, sameSite: 'lax', ttlSeconds: 60 },
    );
    await expect(sessions.signInEvidence('cookie')).resolves.toEqual(
      evidence(),
    );
    await expect(sessions.signInEvidence('cookie')).rejects.toMatchObject({
      code: 'identity.session_invalid',
    });
  });
});
