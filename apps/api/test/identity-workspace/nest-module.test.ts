import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import {
  CreateWorkspaceUseCase,
  INVITATION_ALLOWED_ORIGIN,
  IdentityWorkspaceModule,
  InvitationAcceptanceController,
  InvitationAcceptanceOidcController,
  InvitationAcceptanceUseCase,
  OidcController,
  RenameWorkspaceUseCase,
  SessionController,
  UserController,
  WorkspaceManageGuard,
  WorkspaceInvitationManagementUseCase,
  type IdentityWorkspaceDependencies,
} from '../../src/identity-workspace/index.js';
import {
  OidcLoginService,
  OpaqueSessionService,
} from '../../src/identity/index.js';
import { HttpPlatformModule } from '../../src/platform/http/index.js';

const dependencies: IdentityWorkspaceDependencies = {
  config: {
    oidc: {
      issuer: 'https://issuer.example.test',
      authorizationEndpoint: 'https://issuer.example.test/authorize',
      clientId: 'client',
      redirectUri: 'https://app.example.test/callback',
      scopes: ['openid'],
      transactionTtlMillis: 300_000,
    },
  },
  provider: {
    authorizationUrl: () => 'https://issuer.example.test/authorize',
    exchangeCode: () =>
      Promise.resolve({
        issuer: 'https://issuer.example.test',
        subject: 'subject',
        audience: 'client',
        nonce: 'nonce',
      }),
  },
  transactions: {
    create: () => Promise.resolve(),
    consume: () => Promise.resolve({ status: 'missing' as const }),
  },
  persistence: {
    create: () => Promise.resolve(),
    findByDigest: () => Promise.resolve(undefined),
    revokeByDigest: () => Promise.resolve(false),
    findUserById: () => Promise.resolve(null),
    listAccessibleWorkspaces: () => Promise.resolve({ items: [] }),
    listWorkspaceMembers: () => Promise.resolve({ items: [] }),
    changeWorkspaceMemberRole: () => Promise.reject(new Error('not exercised')),
    resolveOrCreateIdentity: () =>
      Promise.resolve({
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
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
};

/** Identity dependencies for a Better Auth deployment without generic OIDC. */
function sessionAuthorityDependencies(
  config: IdentityWorkspaceDependencies['config'],
): IdentityWorkspaceDependencies {
  return {
    config,
    persistence: dependencies.persistence,
    authorization: dependencies.authorization,
  };
}

const identityWorkspaceTestModule = {
  ...IdentityWorkspaceModule.register(dependencies),
  imports: [HttpPlatformModule],
};

describe('identity/workspace Nest module', () => {
  it('constructs controllers only through the Nest controller registry', () => {
    const dynamic = IdentityWorkspaceModule.register(dependencies);
    const providers = dynamic.providers ?? [];
    for (const controller of [
      OidcController,
      SessionController,
      UserController,
    ]) {
      expect(providers).not.toContain(controller);
      expect(providers).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provide: controller }),
        ]),
      );
    }
  });

  it('registers invitation acceptance under the session authority without generic OIDC', async () => {
    const dynamic = IdentityWorkspaceModule.register(
      sessionAuthorityDependencies({
        publicWebOrigin: 'https://app.example.test',
      }),
    );

    expect(dynamic.controllers).not.toContain(OidcController);
    expect(dynamic.controllers).not.toContain(
      InvitationAcceptanceOidcController,
    );
    expect(dynamic.controllers).toContain(InvitationAcceptanceController);
    expect(dynamic.controllers).toContain(SessionController);
    expect(dynamic.exports).not.toContain(OidcLoginService);
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
      expect(context.get(OpaqueSessionService)).toBeInstanceOf(
        OpaqueSessionService,
      );
      expect(context.get(InvitationAcceptanceUseCase)).toBeInstanceOf(
        InvitationAcceptanceUseCase,
      );
      expect(() => context.get(OidcLoginService)).toThrow();
    } finally {
      await context.close();
    }
  });

  it.each([
    [
      'configuration without provider or store',
      { provider: undefined, transactions: undefined },
    ],
    [
      'a provider without configuration',
      { config: {}, transactions: undefined },
    ],
    [
      'a transaction store without configuration',
      { config: {}, provider: undefined },
    ],
  ])('rejects generic OIDC wiring with %s', (_name, changed) => {
    const selected = Object.fromEntries(
      Object.entries({ ...dependencies, ...changed }).filter(
        ([, value]) => value !== undefined,
      ),
    ) as unknown as IdentityWorkspaceDependencies;

    expect(() => IdentityWorkspaceModule.register(selected)).toThrow(
      'OIDC configuration, provider, and transaction store must be supplied together',
    );
  });

  it('requires a browser origin when neither public origin nor OIDC is configured', () => {
    expect(() =>
      IdentityWorkspaceModule.register(sessionAuthorityDependencies({})),
    ).toThrow('Identity public web origin is not configured');
  });

  it('resolves explicit service providers through a real Nest application context', async () => {
    const context = await NestFactory.createApplicationContext(
      identityWorkspaceTestModule,
      { logger: false, abortOnError: false },
    );
    try {
      expect(context.get(OidcLoginService)).toBeInstanceOf(OidcLoginService);
      expect(context.get(OpaqueSessionService)).toBeInstanceOf(
        OpaqueSessionService,
      );
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

  it('maps a verified OIDC login onto workspace identity persistence', async () => {
    const nonce = 'n'.repeat(43);
    const mapped: unknown[] = [];
    const context = await NestFactory.createApplicationContext(
      {
        ...IdentityWorkspaceModule.register({
          ...dependencies,
          provider: {
            authorizationUrl: () => 'https://issuer.example.test/authorize',
            exchangeCode: () =>
              Promise.resolve({
                issuer: 'https://issuer.example.test',
                subject: 'subject-1',
                audience: 'client',
                nonce,
                email: 'person@example.test',
                displayName: 'Person Example',
              }),
          },
          transactions: {
            create: () => Promise.resolve(),
            consume: () =>
              Promise.resolve({
                status: 'ok' as const,
                transaction: {
                  stateDigest: 'a'.repeat(64),
                  browserBindingDigest: 'b'.repeat(64),
                  codeVerifier: 'v'.repeat(43),
                  nonce,
                  expiresAt: new Date(Date.now() + 60_000),
                },
              }),
          },
          persistence: {
            ...dependencies.persistence,
            resolveOrCreateIdentity: (input) => {
              mapped.push(input);
              return Promise.resolve({
                userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              });
            },
          },
        }),
        imports: [HttpPlatformModule],
      },
      { logger: false, abortOnError: false },
    );

    try {
      const login = await context
        .get(OidcLoginService)
        .completeLogin(
          { state: 's'.repeat(43), code: 'authorization-code' },
          'browser-binding',
        );

      expect(mapped).toEqual([
        {
          issuer: 'https://issuer.example.test',
          providerSubject: 'subject-1',
          email: 'person@example.test',
          displayName: 'Person Example',
        },
      ]);
      expect(login.internalIdentity).toEqual({
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
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
