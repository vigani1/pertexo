import { describe, expect, it } from 'vitest';

import {
  acceptancePersistence,
  invitationPersistence,
  memberRemovalPersistence,
  missingInvitationTokenProtector,
  profilePersistence,
  renamePersistence,
} from '../../src/identity-workspace/persistence-capabilities.js';
import type { IdentityWorkspacePersistence } from '../../src/identity-workspace/ports.js';

type AnyCapability = (...input: never[]) => Promise<unknown>;

const invitationMethods = [
  'listWorkspaceInvitations',
  'createWorkspaceInvitation',
  'resendWorkspaceInvitation',
  'revokeWorkspaceInvitation',
] as const;
const acceptanceMethods = [
  'resolveInvitationAcceptance',
  'readInvitationAcceptance',
  'recordInvitationAcceptanceProof',
  'completeInvitationAcceptance',
  'abandonInvitationAcceptance',
] as const;

const configuredMethods = [
  'renameWorkspace',
  'removeWorkspaceMember',
  'updateUserProfile',
  ...invitationMethods,
  ...acceptanceMethods,
];

function persistenceWith(
  methods: readonly string[],
  calls: string[],
): IdentityWorkspacePersistence {
  const persistence: Record<string, unknown> = { owner: 'configured' };
  for (const method of methods)
    persistence[method] = function (this: { owner: string }) {
      calls.push(`${method}:${this.owner}`);
      return Promise.resolve(method);
    };
  return persistence as unknown as IdentityWorkspacePersistence;
}

async function expectEveryCapabilityRejects(
  capability: Readonly<Record<string, AnyCapability>>,
  message: string,
): Promise<void> {
  for (const method of Object.values(capability))
    await expect(Reflect.apply(method, undefined, [])).rejects.toThrow(message);
}

describe('identity-workspace persistence capabilities', () => {
  it('fails closed when invitation token protection is not configured', () => {
    expect(() =>
      missingInvitationTokenProtector.seal('plaintext', 'associated-data'),
    ).toThrow('Invitation token protection is not configured');
    expect(Object.isFrozen(missingInvitationTokenProtector)).toBe(true);
  });

  it('fails closed for every unconfigured capability group', async () => {
    const persistence = persistenceWith([], []);

    await expectEveryCapabilityRejects(
      renamePersistence(persistence),
      'Workspace rename persistence is not configured',
    );
    await expectEveryCapabilityRejects(
      memberRemovalPersistence(persistence),
      'Workspace member removal persistence is not configured',
    );
    await expectEveryCapabilityRejects(
      profilePersistence(persistence),
      'User profile persistence is not configured',
    );
    await expectEveryCapabilityRejects(
      invitationPersistence(persistence),
      'Invitation persistence is not configured',
    );
    await expectEveryCapabilityRejects(
      acceptancePersistence(persistence),
      'Invitation acceptance persistence is not configured',
    );
  });

  it('treats a partially configured group as unconfigured', async () => {
    const calls: string[] = [];
    const persistence = persistenceWith(
      [...invitationMethods.slice(1), ...acceptanceMethods.slice(0, -1)],
      calls,
    );

    await expectEveryCapabilityRejects(
      invitationPersistence(persistence),
      'Invitation persistence is not configured',
    );
    await expectEveryCapabilityRejects(
      acceptancePersistence(persistence),
      'Invitation acceptance persistence is not configured',
    );
    expect(calls).toEqual([]);
  });

  it('delegates every configured method with its persistence receiver', async () => {
    const calls: string[] = [];
    const persistence = persistenceWith(configuredMethods, calls);
    const capabilities: readonly Readonly<Record<string, AnyCapability>>[] = [
      renamePersistence(persistence),
      memberRemovalPersistence(persistence),
      profilePersistence(persistence),
      invitationPersistence(persistence),
      acceptancePersistence(persistence),
    ];

    for (const capability of capabilities) {
      expect(Object.isFrozen(capability)).toBe(true);
      for (const [method, delegate] of Object.entries(capability))
        await expect(Reflect.apply(delegate, undefined, [])).resolves.toBe(
          method,
        );
    }
    expect(calls).toEqual(
      configuredMethods.map((method) => `${method}:configured`),
    );
  });
});
