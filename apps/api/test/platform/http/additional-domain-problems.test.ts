import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { PreviewIdempotencyConflictError } from '@pertexo/core/previews';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPLICATION_ERROR_MAPPERS } from '../../../src/application-errors.js';
import { HttpPlatformModule } from '../../../src/platform/http/index.js';
import { InvalidWorkspaceMemberCursorError } from '../../../src/workspaces/cursor.js';
import { InvalidAuthenticatedWorkspaceContextError } from '../../../src/workspaces/request/authenticated-context-error.js';

const failure = { current: new Error() };
class FailureController {
  fail(): never {
    throw failure.current;
  }
}

Controller('domain-failure')(FailureController);
const descriptor = Object.getOwnPropertyDescriptor(
  FailureController.prototype,
  'fail',
);
if (descriptor === undefined) throw new Error('Missing fixture route');
Get()(FailureController.prototype, 'fail', descriptor);

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

describe('remaining domain translations over HTTP', () => {
  let api: Awaited<ReturnType<typeof application>>;
  beforeAll(async () => {
    api = await application();
  });
  afterAll(async () => {
    await api.app.close();
  });
  it.each([
    [
      new PreviewIdempotencyConflictError(),
      409,
      'request.idempotency_conflict',
      'The idempotency key was already used for another request.',
    ],
    [
      new InvalidWorkspaceMemberCursorError(),
      400,
      'request.invalid',
      'workspace member cursor is invalid',
    ],
    [
      new InvalidAuthenticatedWorkspaceContextError('Invalid actor context'),
      400,
      'request.invalid',
      'Invalid actor context',
    ],
  ] as const)(
    'preserves the response for %s',
    async (error, status, code, detail) => {
      failure.current = error;
      const response = await api.server.inject({
        method: 'GET',
        url: '/domain-failure',
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ status, code, detail });
    },
  );
});
