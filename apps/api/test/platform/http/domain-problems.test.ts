import 'reflect-metadata';
import { z } from 'zod';
import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/core/authoring';
import { ConnectionSecretVersionConflictError } from '@pertexo/core/connections';
import { WorkspaceAccessDeniedError } from '@pertexo/core/tenant-access';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPLICATION_ERROR_MAPPERS } from '../../../src/application-errors.js';
import { HttpPlatformModule } from '../../../src/platform/http/index.js';
import { domainErrors } from '../../../src/platform/http/problems/interceptor.js';
import { resourceFailure } from '../../../src/problems/context/normalize.js';

const failure = { current: new Error('private failure') };
const workflowPath = '/v1/workspaces/workspace-a/workflows/workflow-a';
const connectionPath = '/v1/workspaces/workspace-a/connections/connection-a';
const workspacePath = '/v1/workspaces/workspace-a';
const unrelatedPath = '/outside-the-feature-route-table';

class FailureController {
  fail(): never {
    throw failure.current;
  }

  guarded(): never {
    throw failure.current;
  }

  resource(): never {
    throw failure.current;
  }
}
Controller()(FailureController);
const failDescriptor = Object.getOwnPropertyDescriptor(
  FailureController.prototype,
  'fail',
);
const resourceDescriptor = Object.getOwnPropertyDescriptor(
  FailureController.prototype,
  'resource',
);
if (failDescriptor === undefined || resourceDescriptor === undefined)
  throw new Error('Missing fixture route');
Get([workspacePath, unrelatedPath])(
  FailureController.prototype,
  'fail',
  failDescriptor,
);
Get([workflowPath, connectionPath])(
  FailureController.prototype,
  'resource',
  resourceDescriptor,
);
const guardedDescriptor = Object.getOwnPropertyDescriptor(
  FailureController.prototype,
  'guarded',
);
if (guardedDescriptor === undefined)
  throw new Error('Missing guarded fixture route');
Get('/unlisted-guarded')(
  FailureController.prototype,
  'guarded',
  guardedDescriptor,
);
UseGuards({
  canActivate: () => {
    throw failure.current;
  },
})(FailureController.prototype, 'guarded', guardedDescriptor);
UseInterceptors(domainErrors(resourceFailure))(
  FailureController.prototype,
  'resource',
  resourceDescriptor,
);

async function application() {
  const module = await Test.createTestingModule({
    imports: [
      HttpPlatformModule.register(
        { log: () => undefined },
        APPLICATION_ERROR_MAPPERS,
      ),
    ],
    controllers: [FailureController],
  }).compile();
  const adapter = new FastifyAdapter();
  const app = module.createNestApplication(adapter);
  await app.init();
  await adapter.getInstance().ready();
  return { app, server: adapter.getInstance() };
}

describe('domain problems over HTTP', () => {
  let api: Awaited<ReturnType<typeof application>>;
  beforeAll(async () => {
    api = await application();
  });
  afterAll(async () => {
    await api.app.close();
  });

  it.each([workflowPath, connectionPath, unrelatedPath])(
    'returns the same missing-workflow problem from %s',
    async (url) => {
      failure.current = new WorkflowNotFoundError();
      const response = await api.server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: 'resource.not_found',
        status: 404,
        instance: url,
      });
      expect(response.json()).not.toHaveProperty('detail');
    },
  );

  it('keeps the draft validator and revision in a conflict response', async () => {
    const etag = '"draft.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"';
    failure.current = new WorkflowRevisionConflictError(3, etag);
    const response = await api.server.inject({
      method: 'GET',
      url: workflowPath,
    });
    expect(response.statusCode).toBe(412);
    expect(response.headers.etag).toBe(etag);
    expect(response.json()).toMatchObject({
      code: 'workflow.revision_conflict',
      currentRevision: 3,
      currentEtag: etag,
      detail: 'The workflow draft has changed; reload it before retrying.',
    });
  });

  it('keeps the credential-conflict problem and its safe message', async () => {
    failure.current = new ConnectionSecretVersionConflictError();
    const response = await api.server.inject({
      method: 'GET',
      url: connectionPath,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'connection.conflict',
      detail:
        'The connection’s secret changed since you opened it. Reload, then try again.',
    });
  });

  it('keeps the workspace authority response', async () => {
    failure.current = new WorkspaceAccessDeniedError();
    const response = await api.server.inject({
      method: 'GET',
      url: workspacePath,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'auth.forbidden' });
  });

  it('does not disclose workspace authority when a resource becomes hidden', async () => {
    failure.current = new WorkspaceAccessDeniedError();
    const response = await api.server.inject({
      method: 'GET',
      url: workflowPath,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'resource.not_found' });
    expect(response.json()).not.toHaveProperty('detail');
  });

  it('keeps validation failures before controller interceptors opaque', async () => {
    const validation = z.object({ privateSettings: z.string() }).safeParse({});
    if (validation.success) throw new Error('Expected rejected validation');
    failure.current = validation.error;
    const response = await api.server.inject({
      method: 'GET',
      url: '/unlisted-guarded',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'request.invalid',
      detail: 'The request is invalid.',
    });
    expect(response.body).not.toContain('private');
    expect(response.json()).not.toHaveProperty('errors');
  });

  it('does not expose an unrecognized failure', async () => {
    failure.current = new Error('private-provider-credential');
    const response = await api.server.inject({
      method: 'GET',
      url: unrelatedPath,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'internal.unexpected' });
    expect(response.body).not.toContain('private-provider-credential');
  });
});
