import 'reflect-metadata';
import { z } from 'zod';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { WorkspaceAccessDeniedError } from '@pertexo/core/tenant-access';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
} from '@pertexo/artifact-store';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from '@pertexo/core/artifacts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APPLICATION_ERROR_MAPPERS } from '../../src/application-errors.js';
import { HttpPlatformModule } from '../../src/platform/http/index.js';
import { ArtifactsController } from '../../src/artifacts/controllers.js';
import { ArtifactService } from '../../src/artifacts/service.js';
import {
  ArtifactReadGuard,
  ArtifactUploadGuard,
} from '../../src/artifacts/guards.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../src/workspaces/index.js';
import {
  artifactId,
  context,
  dependencies,
  service,
  uploadRequest,
  workspaceId,
} from './service/fixture.js';

async function application() {
  const deps = dependencies();
  const builder = Test.createTestingModule({
    imports: [
      HttpPlatformModule.register(
        { log: () => undefined },
        APPLICATION_ERROR_MAPPERS,
      ),
    ],
    controllers: [ArtifactsController],
    providers: [{ provide: ArtifactService, useValue: service(deps) }],
  });
  for (const guard of [
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    ArtifactReadGuard,
    ArtifactUploadGuard,
  ]) {
    builder.overrideGuard(guard).useValue({ canActivate: () => true });
  }
  const module = await builder.compile();
  const adapter = new FastifyAdapter();
  adapter.getInstance().addHook('onRequest', (request, _reply, done) => {
    Object.assign(request, {
      identitySession: {
        userId: context().actor.actorId,
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
    });
    done();
  });
  const app = module.createNestApplication(adapter);
  await app.init();
  await adapter.getInstance().ready();
  return { app, server: adapter.getInstance(), deps };
}

describe('artifact storage problems over the artifact API', () => {
  let api: Awaited<ReturnType<typeof application>>;
  beforeAll(async () => {
    api = await application();
  });
  afterAll(async () => {
    await api.app.close();
  });

  it.each([
    [new ArtifactQuotaExceededError(), 429, 'workspace.quota_exceeded'],
    [new ArtifactUploadNotFoundError(), 404, 'resource.not_found'],
    [
      new ArtifactUploadIdempotencyConflictError(),
      409,
      'request.idempotency_conflict',
    ],
    [
      new ArtifactUploadConflictError('private database detail'),
      409,
      'artifact.conflict',
    ],
    [new Error('private database detail'), 503, 'artifact.unavailable'],
    [
      new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['storedRow'],
          message: 'private database detail',
        },
      ]),
      503,
      'artifact.unavailable',
    ],
    [
      new WorkspaceAccessDeniedError('private access detail'),
      503,
      'artifact.unavailable',
    ],
    [new IdempotencyConflictError(), 503, 'artifact.unavailable'],
    [
      new ArtifactIntegrityError('private database detail'),
      503,
      'artifact.unavailable',
    ],
  ] as const)(
    'preserves the upload response for %s',
    async (error, status, code) => {
      vi.mocked(api.deps.database.beginUpload).mockRejectedValueOnce(error);
      const response = await api.server.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/artifacts/uploads`,
        headers: { 'idempotency-key': 'artifact-problem' },
        payload: uploadRequest,
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ status, code });
      expect(response.body).not.toContain('private');
    },
  );

  it.each([
    [
      new ArtifactIntegrityError('private provider detail'),
      409,
      'artifact.conflict',
    ],
    [new ArtifactNotFoundError(), 409, 'artifact.conflict'],
    [new Error('private provider detail'), 503, 'artifact.unavailable'],
    [
      new WorkspaceAccessDeniedError('private provider detail'),
      503,
      'artifact.unavailable',
    ],
    [new ArtifactQuotaExceededError(), 503, 'artifact.unavailable'],
  ] as const)(
    'preserves the finalize response for %s',
    async (error, status, code) => {
      vi.mocked(api.deps.store.validateDirectUpload).mockRejectedValueOnce(
        error,
      );
      const response = await api.server.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/finalize`,
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ status, code });
      expect(response.body).not.toContain('private');
    },
  );
});
