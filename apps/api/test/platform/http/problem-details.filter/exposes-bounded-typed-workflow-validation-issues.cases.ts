import { HttpException } from '@nestjs/common';

import { expect, it, vi } from 'vitest';

import {
  ProblemDetailsFilter,
  RequestContextStore,
  applicationError,
} from '../../../../src/platform/http/index.js';

import { APPLICATION_ERROR_MAPPERS } from '../../../../src/application-errors.js';

import { responseMock, hostFor } from './fixture.js';

export function registerExposesBoundedTypedWorkflowValidationIssues(): void {
  it('exposes only bounded typed workflow validation issues', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(contexts);
    const response = responseMock();
    contexts.run('request-invalid-workflow', () => {
      filter.catch(
        applicationError('workflow.invalid', {
          details: {
            issues: [
              {
                code: 'cycle',
                path: '/edges/0',
                message: 'The graph contains a cycle.',
                secret: 'must-not-leak',
              },
              { code: 42, path: '/unsafe', message: 'ignored' },
            ],
          },
        }),
        hostFor({ url: '/v1/workflows/workflow-1/publish' }, response),
      );
    });

    expect(response.body).toMatchObject({
      code: 'workflow.invalid',
      status: 422,
      errors: [
        {
          code: 'cycle',
          path: '/edges/0',
          message: 'The graph contains a cycle.',
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
  });

  it('omits invalid retry and validation metadata instead of reflecting it', () => {
    const retryResponse = responseMock();
    const validationResponse = responseMock();
    const filter = new ProblemDetailsFilter(new RequestContextStore());

    filter.catch(
      applicationError('request.rate_limited', {
        details: { retryAfterSeconds: 301 },
      }),
      hostFor({ url: '/v1/workflows' }, retryResponse),
    );
    filter.catch(
      applicationError('workflow.invalid', { details: { issues: 'unsafe' } }),
      hostFor({ url: '/v1/workflows' }, validationResponse),
    );

    expect(retryResponse.header).not.toHaveBeenCalledWith(
      'retry-after',
      expect.anything(),
    );
    expect(retryResponse.body).not.toHaveProperty('errors');
    expect(validationResponse.body).not.toHaveProperty('errors');
  });

  it('drops malformed workflow issue objects field by field', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      applicationError('workflow.invalid', {
        details: {
          issues: [
            null,
            { code: 'cycle', message: 'missing path' },
            { path: '/edges/0', message: 'missing code' },
            { path: '/edges/0', code: 'cycle' },
          ],
        },
      }),
      hostFor({ url: '/v1/workflows' }, response),
    );

    expect(response.body).not.toHaveProperty('errors');
  });

  it('omits an instance when the request URL is unavailable', () => {
    const response = responseMock();
    const logger = { log: vi.fn() };
    new ProblemDetailsFilter(new RequestContextStore(), logger).catch(
      new Error('private failure'),
      hostFor({}, response),
    );

    expect(response.body).not.toHaveProperty('instance');
    expect(logger.log).toHaveBeenCalledWith(
      // Vitest's asymmetric matcher is intentionally dynamic at this boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.not.objectContaining({ instance: expect.anything() }),
    );
  });

  it('omits an instance when the request URL is malformed', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      new Error('private failure'),
      hostFor({ url: 'not an absolute URL' }, response),
    );

    expect(response.body).not.toHaveProperty('instance');
  });

  it('supports Fastify-style response methods and safe fallback context', async () => {
    const code = vi.fn();
    const header = vi.fn();
    const json = vi.fn();
    const logger = {
      log: vi.fn(() => Promise.reject(new Error('logger down'))),
    };
    const response = { code, header, json };

    new ProblemDetailsFilter(new RequestContextStore(), logger).catch(
      new Error('private failure'),
      hostFor(
        {
          url: 'https://api.example.test/v1/health?secret=yes',
          headers: { 'x-request-id': 'fallback-request' },
        },
        response,
      ),
    );

    expect(code).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'fallback-request',
        instance: '/v1/health',
      }),
    );
    await Promise.resolve();
    expect(logger.log).toHaveBeenCalledOnce();
  });

  it.each([
    [400, 'request.invalid'],
    [401, 'auth.unauthenticated'],
    [403, 'auth.forbidden'],
    [404, 'resource.not_found'],
    [503, 'internal.unexpected'],
  ] as const)(
    'preserves a framework %i response when real feature mappers are installed',
    (status, code) => {
      const response = responseMock();
      new ProblemDetailsFilter(
        new RequestContextStore(),
        undefined,
        APPLICATION_ERROR_MAPPERS,
      ).catch(
        new HttpException('framework response', status),
        hostFor(
          { url: '/v1/workspaces/workspace-a/workflows/missing' },
          response,
        ),
      );

      expect(response.status).toHaveBeenCalledWith(status);
      expect(response.body).toMatchObject({ status, code });
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'treats inherited catalog code %s as an unknown failure',
    (code) => {
      const response = responseMock();
      expect(() => {
        new ProblemDetailsFilter(new RequestContextStore()).catch(
          { code },
          hostFor({ url: '/v1/resource' }, response),
        );
      }).not.toThrow();
      expect(response.body).toMatchObject({
        status: 500,
        code: 'internal.unexpected',
      });
    },
  );

  it.each([
    { url: '/v1/workspaces/workspace-a/workflows/workflow-a' },
    {},
    { url: 'http://[invalid' },
  ])('falls back safely when no feature mapper accepts $url', (request) => {
    const response = responseMock();

    new ProblemDetailsFilter(
      new RequestContextStore(),
      undefined,
      APPLICATION_ERROR_MAPPERS,
    ).catch(new Error('private failure'), hostFor(request, response));

    expect(response.body).toMatchObject({
      status: 500,
      code: 'internal.unexpected',
    });
  });
}
