import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import {
  CreateWorkspaceUseCase,
  INVITATION_ALLOWED_ORIGIN,
  IdentityWorkspaceModule,
  InvitationAcceptanceController,
  InvitationAcceptanceUseCase,
  RenameWorkspaceUseCase,
  SessionController,
  UserController,
  WorkspaceManageGuard,
  WorkspaceInvitationManagementUseCase,
  type IdentityWorkspaceDependencies,
  type IdentitySessionAuthority,
  SESSION_AUTHORITY,
} from '../../src/identity-workspace/index.js';
import { HttpPlatformModule } from '../../src/platform/http/index.js';

const sessions = {} as IdentitySessionAuthority;

const dependencies: IdentityWorkspaceDependencies = {
  config: { publicWebOrigin: 'https://app.example.test' },
  persistence: {
    findUserById: () => Promise.resolve(null),
    listAccessibleWorkspaces: () => Promise.resolve({ items: [] }),
    listWorkspaceMembers: () => Promise.resolve({ items: [] }),
    changeWorkspaceMemberRole: () => Promise.reject(new Error('not exercised')),
    createWorkspaceWithOwner: () =>
      Promise.resolve({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'Workspace',
        slug: 'workspace',
        status: 'active' as const,
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    requestWorkspaceLifecycleOperation: () =>
      Promise.resolve({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        commandType: 'deletion_requested' as const,
        status: 'pending' as const,
        submittedAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
        errorCode: null,
      }),
    readWorkspaceLifecycleOperation: () => Promise.resolve(null),
  },
  authorization: { findAccess: () => Promise.resolve(undefined) },
  sessions,
};

const identityWorkspaceTestModule = {
  ...IdentityWorkspaceModule.register(dependencies),
  imports: [HttpPlatformModule],
};

describe('identity/workspace Nest module', () => {
  it('constructs controllers only through the Nest controller registry', () => {
    const dynamic = IdentityWorkspaceModule.register(dependencies);
    const providers = dynamic.providers ?? [];
    for (const controller of [SessionController, UserController]) {
      expect(providers).not.toContain(controller);
      expect(providers).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provide: controller }),
        ]),
      );
    }
  });

  it('registers invitation acceptance under the session authority', async () => {
    const dynamic = IdentityWorkspaceModule.register(dependencies);

    expect(dynamic.controllers).toContain(InvitationAcceptanceController);
    expect(dynamic.controllers).toContain(SessionController);
    expect(dynamic.exports).toContain(InvitationAcceptanceUseCase);
    expect(dynamic.providers).toContainEqual({
      provide: INVITATION_ALLOWED_ORIGIN,
      useValue: 'https://app.example.test',
    });
    const context = await NestFactory.createApplicationContext(
      { ...dynamic, imports: [HttpPlatformModule] },
      { logger: false, abortOnError: false },
    );
    try {
      expect(context.get(SESSION_AUTHORITY)).toBe(sessions);
      expect(context.get(InvitationAcceptanceUseCase)).toBeInstanceOf(
        InvitationAcceptanceUseCase,
      );
    } finally {
      await context.close();
    }
  });

  it('resolves explicit service providers through a real Nest application context', async () => {
    const context = await NestFactory.createApplicationContext(
      identityWorkspaceTestModule,
      { logger: false, abortOnError: false },
    );
    try {
      expect(context.get(SESSION_AUTHORITY)).toBe(sessions);
      expect(context.get(CreateWorkspaceUseCase)).toBeInstanceOf(
        CreateWorkspaceUseCase,
      );
      expect(context.get(WorkspaceManageGuard)).toBeInstanceOf(
        WorkspaceManageGuard,
      );
    } finally {
      await context.close();
    }
  });

  it('fails closed through public use cases when optional workspace persistence is not configured', async () => {
    const context = await NestFactory.createApplicationContext(
      {
        ...IdentityWorkspaceModule.register({
          ...dependencies,
          invitationTokens: {
            seal: () => ({
              ciphertext: 'ciphertext',
              nonce: 'nonce',
              tag: 'tag',
              keyVersion: 'invite-v1',
            }),
          },
        }),
        imports: [HttpPlatformModule],
      },
      { logger: false, abortOnError: false },
    );
    const actor = {
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      kind: 'user' as const,
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      requestId: 'request-module-fallbacks',
    };
    const invitationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const intentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const binding = `wb1.${actor.workspaceId}.${intentId}.${'a'.repeat(43)}.${'b'.repeat(43)}`;

    try {
      const invitations = context.get(WorkspaceInvitationManagementUseCase);
      const acceptance = context.get(InvitationAcceptanceUseCase);
      const rename = context.get(RenameWorkspaceUseCase);

      await expect(
        invitations.list({ actor, routeWorkspaceId: actor.workspaceId }),
      ).rejects.toThrow('Invitation persistence is not configured');
      await expect(
        invitations.create({
          actor,
          routeWorkspaceId: actor.workspaceId,
          idempotencyKey: 'invite-create-fallback',
          request: { email: 'recipient@example.test', role: 'viewer' },
        }),
      ).rejects.toThrow('Invitation persistence is not configured');
      await expect(
        invitations.resend({
          actor,
          routeWorkspaceId: actor.workspaceId,
          invitationId,
          idempotencyKey: 'invite-resend-fallback',
          request: { expectedRevision: 1 },
        }),
      ).rejects.toThrow('Invitation persistence is not configured');
      await expect(
        invitations.revoke({
          actor,
          routeWorkspaceId: actor.workspaceId,
          invitationId,
          idempotencyKey: 'invite-revoke-fallback',
          request: { expectedRevision: 1 },
        }),
      ).rejects.toThrow('Invitation persistence is not configured');

      await expect(
        acceptance.resolve({
          token: `wi1.${actor.workspaceId}.${invitationId}.${'c'.repeat(43)}`,
        }),
      ).rejects.toThrow('Invitation acceptance persistence is not configured');
      await expect(acceptance.read(binding)).rejects.toThrow(
        'Invitation acceptance persistence is not configured',
      );
      await expect(acceptance.abandon(binding, 'b'.repeat(43))).rejects.toThrow(
        'Invitation acceptance persistence is not configured',
      );

      await expect(
        rename.execute({
          actor,
          routeWorkspaceId: actor.workspaceId,
          idempotencyKey: 'workspace-rename-fallback',
          request: { name: 'Renamed workspace', expectedRevision: 1 },
        }),
      ).rejects.toThrow('Workspace rename persistence is not configured');
    } finally {
      await context.close();
    }
  });

  it('constructs every optional workspace persistence adapter when configured', async () => {
    const notExercised = () => Promise.reject(new Error('not exercised'));
    const context = await NestFactory.createApplicationContext(
      {
        ...IdentityWorkspaceModule.register({
          ...dependencies,
          persistence: {
            ...dependencies.persistence,
            renameWorkspace: notExercised,
            listWorkspaceInvitations: notExercised,
            createWorkspaceInvitation: notExercised,
            resendWorkspaceInvitation: notExercised,
            revokeWorkspaceInvitation: notExercised,
            resolveInvitationAcceptance: notExercised,
            readInvitationAcceptance: notExercised,
            recordInvitationAcceptanceProof: notExercised,
            completeInvitationAcceptance: notExercised,
            abandonInvitationAcceptance: notExercised,
          },
        }),
        imports: [HttpPlatformModule],
      },
      { logger: false, abortOnError: false },
    );

    try {
      expect(context.get(RenameWorkspaceUseCase)).toBeInstanceOf(
        RenameWorkspaceUseCase,
      );
      expect(context.get(WorkspaceInvitationManagementUseCase)).toBeInstanceOf(
        WorkspaceInvitationManagementUseCase,
      );
      expect(context.get(InvitationAcceptanceUseCase)).toBeInstanceOf(
        InvitationAcceptanceUseCase,
      );
    } finally {
      await context.close();
    }
  });
});
