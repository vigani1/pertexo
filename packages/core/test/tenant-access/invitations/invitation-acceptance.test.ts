import { describe, expect, it } from 'vitest';
import { decideInvitationAcceptance } from '../../src/index.js';

const now = new Date('2026-10-25T12:00:00.000Z');
function facts() {
  return {
    actorUserId: 'recipient',
    invitationRevision: 3,
    intent: {
      expiresAt: new Date(now.getTime() + 1),
      status: 'verified',
      verifiedSessionId: 'session',
      verifiedUserId: 'recipient',
      verifiedAt: new Date(now.getTime() - 5 * 60_000),
      invitationRevision: 3,
      verifiedEmail: 'recipient@example.test',
    },
    current: {
      status: 'pending',
      expiresAt: new Date(now.getTime() + 1),
      revision: 3,
      email: 'recipient@example.test',
      role: 'viewer',
    },
    previewSessionId: 'session',
    sourceSession: { userId: 'recipient', proof: 'credential' },
    userStatus: 'active',
    workspaceStatus: 'active',
    now,
  };
}

describe('invitation acceptance decision', () => {
  it('accepts the exact five-minute proof boundary and preserves the locked records', () => {
    const input = facts();
    expect(decideInvitationAcceptance(input)).toEqual({
      allowed: true,
      current: input.current,
      sourceSession: input.sourceSession,
    });
  });

  it.each([
    ['member_inactive', { userStatus: 'suspended' }],
    ['proof_expired', { sourceSession: undefined }],
    [
      'proof_expired',
      { sourceSession: { userId: 'different', proof: 'credential' } },
    ],
    ['proof_expired', { previewSessionId: 'replaced-session' }],
    ['revision_conflict', { invitationRevision: 4 }],
    ['workspace_inactive', { workspaceStatus: 'pending_deletion' }],
    ['superseded', { current: undefined }],
    ['superseded', { current: { ...facts().current, status: 'revoked' } }],
    ['superseded', { current: { ...facts().current, revision: 4 } }],
    ['superseded', { current: { ...facts().current, expiresAt: now } }],
    [
      'recipient_mismatch',
      { current: { ...facts().current, email: 'other@example.test' } },
    ],
  ] as const)('refuses %s from the current snapshot', (reason, patch) => {
    expect(decideInvitationAcceptance({ ...facts(), ...patch })).toMatchObject({
      allowed: false,
      reason,
    });
  });

  it.each([
    ['expired', { expiresAt: now }],
    ['superseded', { status: 'superseded' }],
    ['proof_expired', { status: 'pending' }],
    ['proof_expired', { verifiedUserId: 'different' }],
    ['proof_expired', { verifiedAt: null }],
    ['proof_expired', { verifiedAt: new Date(now.getTime() - 5 * 60_000 - 1) }],
    ['revision_conflict', { invitationRevision: 4 }],
  ] as const)('refuses %s from the current intent', (reason, patch) => {
    const input = facts();
    expect(
      decideInvitationAcceptance({
        ...input,
        intent: { ...input.intent, ...patch },
      }),
    ).toMatchObject({ allowed: false, reason });
  });

  it('keeps inactive-user refusal ahead of expired or superseded proof', () => {
    const input = facts();
    expect(
      decideInvitationAcceptance({
        ...input,
        userStatus: 'suspended',
        intent: { ...input.intent, status: 'superseded', expiresAt: now },
      }),
    ).toMatchObject({ allowed: false, reason: 'member_inactive' });
  });
});
