import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import {
  CreateWorkspaceUseCase,
  IdentityWorkspaceModule,
  type IdentityWorkspaceDependencies,
} from '../../src/identity-workspace/index.js';
import {
  OidcLoginService,
  OpaqueSessionService,
} from '../../src/identity/index.js';

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
    requestWorkspaceDeletion: () =>
      Promise.resolve({
        workspace: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          name: 'Workspace',
          slug: 'workspace',
          status: 'pending_deletion' as const,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        revokedSessionCount: 0,
      }),
    restoreWorkspace: () =>
      Promise.resolve({
        workspace: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          name: 'Workspace',
          slug: 'workspace',
          status: 'suspended' as const,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        revokedSessionCount: 0,
      }),
  },
  authorization: { findAccess: () => Promise.resolve(undefined) },
};

describe('identity/workspace Nest module', () => {
  it('resolves explicit service providers through a real Nest application context', async () => {
    const context = await NestFactory.createApplicationContext(
      IdentityWorkspaceModule.register(dependencies),
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
    } finally {
      await context.close();
    }
  });
});
