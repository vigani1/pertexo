import { toProblem } from '../../../../src/problems/registry.js';
import { workspaceFailure } from '../../../../src/problems/context/normalize.js';
import { expect, it, vi } from 'vitest';
import { WorkspaceInvitationCommandConflictError } from '@pertexo/core/tenant-access';
import { nodeIdentityCrypto } from '../../../../src/identity/index.js';
import { WorkspaceInvitationManagementUseCase } from '../../../../src/workspaces/index.js';
import type {
  InvitationAcceptanceResolvePersistenceInput,
  WorkspaceInvitationCreatePersistenceInput,
} from '../../../../src/workspaces/ports.js';
import {
  workspaceId,
  invitationId,
  intentId,
  actorId,
  now,
  invitationRecord,
  acceptanceUseCase,
} from './fixture.js';

export function registerMapsUnresolvedDeliveryTruthfulRecoverableProblem(): void {
  it('maps unresolved delivery to a truthful recoverable problem', () => {
    expect(
      toProblem(
        workspaceFailure(
          new WorkspaceInvitationCommandConflictError(
            'delivery_unresolved',
            'delivery remains unknown',
          ),
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
          verifiedSessionId: null,
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
}
