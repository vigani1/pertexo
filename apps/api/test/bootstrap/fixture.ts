import { unusedWorkspacePersistence } from '../support/identity-workspace.fixture.js';
import {
  stubFederationService,
  stubDirectoryStore,
} from '../support/federation.js';

import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type { TelemetryLifecycle } from '@pertexo/observability/server';
import { vi } from 'vitest';
import type { createApiApplication } from '../../src/app.js';
import { IdentityError } from '../../src/identity/index.js';
import type { IdentityWorkspaceDependencies } from '../../src/workspaces/index.js';

import type { ApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';

import type { ApiArtifactRuntime } from '../../src/platform/artifacts/artifacts-runtime.module.js';
import type { BetterAuthRuntime } from '../../src/authentication/index.js';

import { createApiPlatformFixture } from '../support/api-platform.fixture.js';

export const { config, database, logger, rateLimitConsumer, telemetry } =
  createApiPlatformFixture('0000_rls_probe.sql');

export function dependencies(
  selectedDatabase: WorkspaceDatabase = database,
  selectedTelemetry: TelemetryLifecycle = telemetry,
) {
  return {
    database: selectedDatabase,
    logger,
    rateLimitConsumer,
    telemetry: selectedTelemetry,
  };
}

export function identityRuntime(
  close = vi.fn().mockResolvedValue(undefined),
  authenticated = false,
  changeWorkspaceMemberRole: IdentityWorkspaceDependencies['persistence']['changeWorkspaceMemberRole'] = () =>
    Promise.reject(new Error('not used')),
): ApiIdentityRuntime {
  const notUsed = () => Promise.reject(new Error('not used'));
  const identityDependencies: IdentityWorkspaceDependencies = {
    config: { publicWebOrigin: 'https://app.example.test' },
    persistence: {
      ...unusedWorkspacePersistence(),
      findUserById: (userId) =>
        Promise.resolve({
          id: userId,
          email: 'current-user@example.test',
          displayName: 'Current User',
          status: 'active',
          profileRevision: 1,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      listAccessibleWorkspaces: () => Promise.resolve({ items: [] }),
      listWorkspaceMembers: () => Promise.resolve({ items: [] }),
      changeWorkspaceMemberRole,
      createWorkspaceWithOwner: notUsed,
      requestWorkspaceLifecycleOperation: notUsed,
    },
    authorization: {
      findAccess: ({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(
          authenticated &&
            workspaceId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            ? {
                actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                role: 'owner' as const,
                membershipStatus: 'active' as const,
                workspaceStatus: 'active' as const,
              }
            : undefined,
        ),
    },
    sessions: {
      issue: notUsed,
      authenticate: vi.fn(() =>
        authenticated
          ? Promise.resolve({
              sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              expiresAt: new Date(Date.now() + 60_000),
              clientMetadata: {},
            })
          : Promise.reject(new IdentityError('identity.session_invalid')),
      ),
      revoke: () => Promise.resolve(),
      deliver: notUsed,
      signInEvidence: notUsed,
    },
  };
  return Object.freeze({
    dependencies: identityDependencies,
    people: notUsed,
    federation: stubFederationService(),
    directory: stubDirectoryStore(),
    automation: {
      enabled: false,
      clock: { now: () => new Date() },
      database: {
        create: notUsed,
        list: notUsed,
        revoke: notUsed,
        authenticate: notUsed,
        close: () => Promise.resolve(),
      },
    },
    betterAuth: {
      signUp: { availableToEveryone: () => Promise.resolve(true) },
    } as unknown as BetterAuthRuntime,
    close,
  });
}

export function artifactRuntime(): ApiArtifactRuntime {
  return {
    dependencies: {
      authorization: identityRuntime().dependencies.authorization,
      database: {
        beginUpload: vi.fn(),
        finalizeUpload: vi.fn(),
        getForUpload: vi.fn(),
        getMetadata: vi.fn(),
      },
      store: {
        beginDirectUpload: vi.fn(),
        validateDirectUpload: vi.fn(),
        beginDirectDownload: vi.fn(),
        checkReadiness: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        getStream: vi.fn(),
      },
      formUploads: {
        discover: vi.fn(),
        begin: vi.fn(),
        read: vi.fn(),
        finalize: vi.fn(),
      },
    },
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

export const applicationFixture: {
  application: Awaited<ReturnType<typeof createApiApplication>> | undefined;
} = { application: undefined };

export async function cleanAPIBootstrapOwnershipHealthFixture() {
  await applicationFixture.application?.close();
  applicationFixture.application = undefined;
}
