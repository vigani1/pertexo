import { describe, expect, it, vi } from 'vitest';
import {
  InvitationAcceptanceConflictError,
  WorkspaceInvitationCommandConflictError,
} from '@pertexo/database/api';
import {
  DoubleSubmitCsrfPolicy,
  IdentityError,
  nodeIdentityCrypto,
  type OpaqueSessionService,
} from '../../src/identity/index.js';
import {
  InvitationAcceptanceController,
  InvitationAcceptanceUseCase,
  mapIdentityWorkspaceError,
  WorkspaceInvitationManagementUseCase,
  type CookieResponse,
  type IdentityWorkspaceRequest,
} from '../../src/identity-workspace/index.js';
import type {
  IdentityWorkspacePersistence,
  InvitationAcceptanceResolvePersistenceInput,
  WorkspaceInvitationCreatePersistenceInput,
} from '../../src/identity-workspace/ports.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const invitationId = '22222222-2222-4222-8222-222222222222';
const intentId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-09-19T12:00:00.000Z');

function invitationRecord() {
  return {
    id: invitationId,
    workspaceId,
    email: 'recipient@example.test',
    role: 'viewer' as const,
    status: 'pending' as const,
    revision: 1,
    deliveryStatus: 'queued' as const,
    expiresAt: new Date('2026-09-26T12:00:00.000Z'),
    createdAt: now,
    updatedAt: now,
  };
}

describe('workspace invitation use cases', () => {
  it('maps unresolved delivery to a truthful recoverable problem', () => {
    expect(
      mapIdentityWorkspaceError(
        new WorkspaceInvitationCommandConflictError(
          'delivery_unresolved',
          'delivery remains unknown',
        ),
      ),
    ).toMatchObject({
      code: 'workspace.invitation_delivery_unavailable',
      safeDetail:
        'The prior delivery outcome must be reconciled before resending.',
    });
  });

  it('creates a sealed identifier-only delivery command without exposing the token', async () => {
    const createWorkspaceInvitation = vi.fn(
      (input: WorkspaceInvitationCreatePersistenceInput) =>
        Promise.resolve({
          invitation: invitationRecord(),
          replayed: false,
          input,
        }),
    );
    const seal = vi.fn().mockReturnValue({
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      tag: 'tag',
      keyVersion: 'invite-v1',
    });
    const useCase = new WorkspaceInvitationManagementUseCase(
      {
        listWorkspaceInvitations: vi.fn(),
        createWorkspaceInvitation,
        resendWorkspaceInvitation: vi.fn(),
        revokeWorkspaceInvitation: vi.fn(),
      },
      { seal },
      nodeIdentityCrypto,
      { now: () => now },
    );

    const response = await useCase.create({
      actor: {
        actorId,
        kind: 'user',
        workspaceId,
        sessionId: '55555555-5555-4555-8555-555555555555',
        requestId: 'request-invite',
      },
      routeWorkspaceId: workspaceId,
      idempotencyKey: 'invite-command-1',
      request: { email: 'Recipient@Example.test', role: 'viewer' },
    });

    const command = createWorkspaceInvitation.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      workspaceId,
      actorUserId: actorId,
      email: 'recipient@example.test',
      idempotencyKey: 'invite-command-1',
    });
    expect(seal).toHaveBeenCalledWith(
      expect.stringMatching(/^wi1\.[^.]+\.[^.]+\.[A-Za-z0-9_-]{43}$/u),
      expect.stringMatching(/^pertexo\/workspace-invitation\//u),
    );
    expect(JSON.stringify(response)).not.toContain('wi1.');
    expect(response.invitation.deliveryStatus).toBe('queued');
  });

  it('does not create an intent for a malformed token', async () => {
    const resolveInvitationAcceptance = vi.fn();
    const useCase = acceptanceUseCase({ resolveInvitationAcceptance });

    await expect(useCase.resolve({ token: 'x'.repeat(48) })).resolves.toEqual({
      journey: { state: 'unavailable' },
    });
    expect(resolveInvitationAcceptance).not.toHaveBeenCalled();
  });

  it('passes the prior browser binding into the atomic replacement command', async () => {
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
          verifiedEmail: null,
          verifiedAt: null,
          workspaceName: 'Control Operations',
          invitationRole: 'viewer' as const,
          invitationStatus: 'pending' as const,
          acceptedUserId: null,
          receipt: null,
        }),
    );
    const useCase = acceptanceUseCase({
      resolveInvitationAcceptance,
    });
    const token = `wi1.${workspaceId}.${invitationId}.${'a'.repeat(43)}`;
    const first = await useCase.resolve({ token });
    expect(first.binding).toBeDefined();
    const second = await useCase.resolve({ token }, first.binding);

    expect(second.binding).not.toBe(first.binding);
    const firstCommand = resolveInvitationAcceptance.mock.calls[0]?.[0];
    const replacementCommand = resolveInvitationAcceptance.mock.calls[1]?.[0];
    expect(replacementCommand?.priorBinding).toMatchObject({
      workspaceId,
      intentId: firstCommand?.intentId,
    });
    expect(replacementCommand?.priorBinding?.bindingDigest).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it('reproduces the same replacement binding for an exact resolver retry', async () => {
    const commands: InvitationAcceptanceResolvePersistenceInput[] = [];
    const resolveInvitationAcceptance = vi.fn(
      (input: InvitationAcceptanceResolvePersistenceInput) => {
        commands.push(input);
        return Promise.resolve({
          id: input.intentId,
          workspaceId,
          invitationId,
          invitationRevision: 1,
          status: 'pending' as const,
          expiresAt: new Date('2026-09-19T12:15:00.000Z'),
          verifiedUserId: null,
          verifiedEmail: null,
          verifiedAt: null,
          workspaceName: 'Control Operations',
          invitationRole: 'viewer' as const,
          invitationStatus: 'pending' as const,
          acceptedUserId: null,
          receipt: null,
        });
      },
    );
    const useCase = acceptanceUseCase({ resolveInvitationAcceptance });
    const token = `wi1.${workspaceId}.${invitationId}.${'a'.repeat(43)}`;
    const priorBinding = `wb1.${workspaceId}.${intentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`;

    const committed = await useCase.resolve({ token }, priorBinding);
    const recovered = await useCase.resolve({ token }, priorBinding);

    expect(recovered).toEqual(committed);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  });

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
      {} as OpaqueSessionService,
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

  it('does not advertise OIDC for an abandoned bound journey', async () => {
    const readInvitationAcceptance = vi.fn().mockResolvedValue({
      id: intentId,
      workspaceId,
      invitationId,
      invitationRevision: 1,
      status: 'abandoned',
      expiresAt: new Date('2026-09-19T12:15:00.000Z'),
      verifiedUserId: null,
      verifiedEmail: null,
      verifiedAt: null,
      workspaceName: 'Control Operations',
      invitationRole: 'viewer',
      invitationStatus: 'pending',
      acceptedUserId: null,
      receipt: null,
    });
    const startLogin = vi.fn();
    const useCase = new InvitationAcceptanceUseCase(
      {
        resolveInvitationAcceptance: vi.fn(),
        readInvitationAcceptance,
        recordInvitationAcceptanceProof: vi.fn(),
        completeInvitationAcceptance: vi.fn(),
        abandonInvitationAcceptance: vi.fn(),
      },
      { startLogin, completeLogin: vi.fn() },
      nodeIdentityCrypto,
      { now: () => now },
      {
        oidc: {
          issuer: 'https://issuer.test',
          authorizationEndpoint: 'https://issuer.test/authorize',
          clientId: 'client',
          redirectUri: 'https://api.test/callback',
          scopes: ['openid', 'email'],
          transactionTtlMillis: 300_000,
        },
      },
    );
    const binding = `wb1.${workspaceId}.${intentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`;

    await expect(useCase.read(binding)).resolves.toEqual({
      state: 'unavailable',
    });
    await expect(
      useCase.startOidc(binding, 'c'.repeat(43)),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(startLogin).not.toHaveBeenCalled();
  });

  it('maps expired recipient proof separately from other invitation conflicts', () => {
    expect(
      mapIdentityWorkspaceError(
        new InvitationAcceptanceConflictError(
          'proof_expired',
          'Fresh recipient verification is required',
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

  it('rejects invitation proof without a provider-verified email', async () => {
    const useCase = acceptanceUseCase({});
    await expect(
      useCase.recordProof({
        externalIdentity: { issuer: 'https://issuer.test', subject: 'subject' },
        internalIdentity: { userId: actorId },
        verifiedProfile: {
          email: 'recipient@example.test',
          displayName: 'Recipient',
          emailVerified: false,
        },
        continuation: {
          kind: 'invitation_acceptance',
          workspaceId,
          intentId,
          bindingDigest: 'a'.repeat(64),
        },
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });
});

function acceptanceUseCase(
  overrides: Partial<
    Pick<
      IdentityWorkspacePersistence,
      | 'resolveInvitationAcceptance'
      | 'readInvitationAcceptance'
      | 'recordInvitationAcceptanceProof'
      | 'completeInvitationAcceptance'
      | 'abandonInvitationAcceptance'
    >
  >,
) {
  return new InvitationAcceptanceUseCase(
    {
      resolveInvitationAcceptance: vi.fn(),
      readInvitationAcceptance: vi.fn(),
      recordInvitationAcceptanceProof: vi.fn(),
      completeInvitationAcceptance: vi.fn(),
      abandonInvitationAcceptance: vi.fn(),
      ...overrides,
    },
    { startLogin: vi.fn(), completeLogin: vi.fn() },
    nodeIdentityCrypto,
    { now: () => now },
    {
      oidc: {
        issuer: 'https://issuer.test',
        authorizationEndpoint: 'https://issuer.test/authorize',
        clientId: 'client',
        redirectUri: 'https://api.test/callback',
        scopes: ['openid', 'email'],
        transactionTtlMillis: 300_000,
      },
    },
  );
}
