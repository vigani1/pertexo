import { randomUUID } from 'node:crypto';
import type { WorkflowAuthoringDatabase } from '@pertexo/database/api';
import { describe, expect, it, vi } from 'vitest';
import { acquireApiRuntimes, cleanupApiRuntimes } from '../src/api-runtimes.js';
import type { ApiIdentityRuntime } from '../src/platform/identity/identity-runtime.module.js';
import {
  createApiPlatformFixture,
  createStubApiWorkflowRuntime,
} from './support/api-platform.fixture.js';

describe('API runtime organization configuration forwarding', () => {
  it.each([false, true])(
    'composes optional organization configuration=%s through the real workflow runtime',
    async (configured) => {
      const fixture = createApiPlatformFixture('unused');
      const authorization = { findAccess: () => Promise.resolve(undefined) };
      const stub = createStubApiWorkflowRuntime(authorization);
      const authoringClose = vi.fn().mockResolvedValue(undefined);
      // The existing authoring port supplies unused transport methods; metadata
      // stores are genuinely constructed, remain lazy, and are owned by teardown.
      const authoring = {
        ...stub.dependencies.persistence,
        close: authoringClose,
      } as unknown as WorkflowAuthoringDatabase;
      const identityClose = vi.fn().mockResolvedValue(undefined);
      const identityRuntime = {
        dependencies: { authorization },
        close: identityClose,
      } as unknown as ApiIdentityRuntime;
      const runtime = await acquireApiRuntimes(
        {
          ...fixture.config,
          database: {
            ...fixture.config.database,
            connectionString:
              'postgresql://pertexo_app:unused@127.0.0.1:1/pertexo_test_f07_no_connection',
            max: 1,
          },
          ...(configured
            ? {
                workflowOrganization: {
                  cursorSigningKey: Buffer.alloc(32, 0x7a).toString('base64'),
                },
              }
            : {}),
        },
        {
          database: fixture.database,
          logger: fixture.logger,
          telemetry: fixture.telemetry,
          identityRuntime,
          workflowOverrides: {
            authoring: { database: authoring },
            persistence: { runs: stub.runDependencies.persistence },
            streaming: { streamer: stub.runDependencies.streamer },
          },
        },
      );
      try {
        const organization = runtime.workflowRuntime?.dependencies.organization;
        if (!configured) expect(organization).toBeUndefined();
        else {
          expect(organization).toBeDefined();
          if (!organization)
            throw new Error('Configured organization runtime missing');
          expect(Object.keys(organization).sort()).toEqual([
            'batches',
            'cursors',
            'favorites',
            'folders',
            'reader',
            'tags',
          ]);
          const scope = {
            purpose: 'tags' as const,
            actorId: randomUUID(),
            workspaceId: randomUUID(),
            selectedTagId: null,
          };
          const item = { id: randomUUID() };
          expect(
            organization.cursors.pages.decode(
              organization.cursors.pages.encode(scope, item),
              scope,
            ),
          ).toEqual(item);
        }
      } finally {
        expect(await cleanupApiRuntimes(runtime)).toEqual([]);
      }
      expect(identityClose).toHaveBeenCalledOnce();
      expect(authoringClose).toHaveBeenCalledOnce();
    },
  );
});
