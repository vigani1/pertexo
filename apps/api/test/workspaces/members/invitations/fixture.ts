import { vi } from 'vitest';

import { nodeIdentityCrypto } from '../../../../src/identity/index.js';
import { InvitationAcceptanceUseCase } from '../../../../src/workspaces/index.js';
import type { IdentityWorkspacePersistence } from '../../../../src/workspaces/ports.js';

export const workspaceId = '11111111-1111-4111-8111-111111111111';

export const invitationId = '22222222-2222-4222-8222-222222222222';

export const intentId = '33333333-3333-4333-8333-333333333333';

export const actorId = '44444444-4444-4444-8444-444444444444';

export const now = new Date('2026-09-19T12:00:00.000Z');

export function invitationRecord() {
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

export function pendingIntent() {
  return {
    id: intentId,
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
  };
}

export function acceptanceUseCase(
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
    nodeIdentityCrypto,
    { now: () => now },
    {
      publicWebOrigin: 'https://web.example.test',
      session: { ttlMillis: 60_000 },
    },
  );
}
