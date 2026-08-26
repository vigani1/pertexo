import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import {
  CreateWorkspaceUseCase,
  IdentityWorkspaceModule,
  WorkspaceManageGuard,
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

const identityWorkspaceTestModule = {
  ...IdentityWorkspaceModule.register(dependencies),
  imports: [HttpPlatformModule],
};

describe('identity/workspace Nest module', () => {
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
});
