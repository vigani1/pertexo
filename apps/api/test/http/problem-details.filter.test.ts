import { BadRequestException, HttpException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { apiProblemSchema } from '@pertexo/contracts/errors';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ProblemDetailsFilter,
  RequestContextStore,
  applicationError,
} from '../../src/platform/http/index.js';
import { IdentityError } from '../../src/identity/index.js';
import { mapIdentityWorkspaceError } from '../../src/identity-workspace/index.js';
import { APPLICATION_ERROR_MAPPERS } from '../../src/application-error-mappers.js';

interface ResponseMock {
  body?: unknown;
  status: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function responseMock(): ResponseMock {
  const response: ResponseMock = {
    body: undefined,
    status: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
  };

  response.status.mockReturnValue(response);
  response.send.mockImplementation((body: unknown) => {
    response.body = body;
  });
  return response;
}

function hostFor(
  request: Readonly<{
    url?: string;
    headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  }>,
  response: ResponseMock | object,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('RFC 9457 problem details filter', () => {
  it('exposes the current lifecycle revision without a draft ETag or untrusted details', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      applicationError('workflow.lifecycle_conflict', {
        details: { currentLifecycleRevision: 7, secret: 'not-public' },
      }),
      hostFor(
        { url: '/v1/workspaces/workspace/workflows/workflow/archive' },
        response,
      ),
    );
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.body).toMatchObject({
      code: 'workflow.lifecycle_conflict',
      currentLifecycleRevision: 7,
    });
    expect(response.body).not.toHaveProperty('secret');
    expect(response.body).not.toHaveProperty('currentEtag');
    expect(response.header).not.toHaveBeenCalledWith('etag', expect.anything());
  });
  it.each([undefined, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])(
    'fails closed for invalid lifecycle conflict revision %j',
    (currentLifecycleRevision) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        applicationError('workflow.lifecycle_conflict', {
          details: { currentLifecycleRevision },
        }),
        hostFor({}, response),
      );
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.body).toMatchObject({ code: 'internal.unexpected' });
      expect(response.body).not.toHaveProperty('currentLifecycleRevision');
    },
  );
  it('rejects oversized safe details before they can reach the response boundary', () => {
    expect(() =>
      applicationError('request.invalid', { safeDetail: 'x'.repeat(2_001) }),
    ).toThrow(/too long/u);
  });

  it('drops blank safe detail instead of emitting an empty detail field', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      applicationError('request.invalid', { safeDetail: '\r\n  ' }),
      hostFor({ url: '/v1/resource' }, response),
    );

    expect(response.body).not.toHaveProperty('detail');
  });

  it('maps a known application error to a safe problem document', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(contexts);
    const response = responseMock();

    contexts.run('request-forbidden', () => {
      filter.catch(
        applicationError('auth.forbidden', {
          safeDetail: 'The actor cannot manage this workspace.',
        }),
        hostFor({ url: '/v1/workspaces/workspace-a' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.header).toHaveBeenCalledWith(
      'content-type',
      'application/problem+json',
    );
    expect(response.body).toEqual({
      type: 'urn:pertexo:problem:auth.forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'The actor cannot manage this workspace.',
      instance: '/v1/workspaces/workspace-a',
      code: 'auth.forbidden',
      requestId: 'request-forbidden',
    });
    expect(apiProblemSchema.safeParse(response.body).success).toBe(true);
  });

  it('renders workspace semantic conflicts as stable RFC 9457 409 problems', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(contexts);
    const response = responseMock();

    contexts.run('request-workspace-conflict', () => {
      filter.catch(
        applicationError('workspace.conflict', {
          safeDetail: 'The workspace slug is already in use.',
        }),
        hostFor({ url: '/v1/workspaces' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.body).toEqual({
      type: 'urn:pertexo:problem:workspace.conflict',
      title: 'Workspace conflict',
      status: 409,
      detail: 'The workspace slug is already in use.',
      instance: '/v1/workspaces',
      code: 'workspace.conflict',
      requestId: 'request-workspace-conflict',
    });
  });

  it('returns a bounded Retry-After header for workspace admission exhaustion', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(contexts);
    const response = responseMock();

    contexts.run('request-quota', () => {
      filter.catch(
        applicationError('workspace.quota_exceeded', {
          safeDetail: 'The workspace queued-run limit has been reached.',
          details: { retryAfterSeconds: 5 },
        }),
        hostFor({ url: '/v1/workflows/workflow-a/runs' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.header).toHaveBeenCalledWith('retry-after', '5');
    expect(response.body).toMatchObject({
      type: 'urn:pertexo:problem:workspace.quota_exceeded',
      status: 429,
      code: 'workspace.quota_exceeded',
    });
    expect(apiProblemSchema.safeParse(response.body).success).toBe(true);
  });

  it('returns a generic bounded Retry-After problem for abuse limits', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(contexts);
    const response = responseMock();

    contexts.run('request-rate-limited', () => {
      filter.catch(
        applicationError('request.rate_limited', {
          details: { retryAfterSeconds: 60, limitedDimension: 'actor' },
        }),
        hostFor({ url: '/v1/workspaces/workspace-a/connections' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.header).toHaveBeenCalledWith('retry-after', '60');
    expect(response.body).toEqual({
      type: 'urn:pertexo:problem:request.rate_limited',
      title: 'Request rate limit reached',
      status: 429,
      instance: '/v1/workspaces/workspace-a/connections',
      code: 'request.rate_limited',
      requestId: 'request-rate-limited',
    });
  });

  it('returns Retry-After when the regional recovery-point fence pauses writes', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(contexts);
    const response = responseMock();

    contexts.run('request-regional-fence', () => {
      filter.catch(
        applicationError('platform.write_paused', {
          details: { retryAfterSeconds: 5 },
        }),
        hostFor({ url: '/v1/workflows/workflow-a/runs' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.header).toHaveBeenCalledWith('retry-after', '5');
    expect(response.body).toMatchObject({
      type: 'urn:pertexo:problem:platform.write_paused',
      status: 503,
      code: 'platform.write_paused',
    });
    expect(apiProblemSchema.safeParse(response.body).success).toBe(true);
  });

  it('renders identity provider outages as a fixed safe RFC 9457 503 problem', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(contexts);
    const response = responseMock();

    contexts.run('request-provider-outage', () => {
      filter.catch(
        mapIdentityWorkspaceError(
          new IdentityError('identity.provider_unavailable'),
        ),
        hostFor({ url: '/v1/auth/oidc/callback?code=secret' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.body).toEqual({
      type: 'urn:pertexo:problem:provider.unavailable',
      title: 'Provider unavailable',
      status: 503,
      detail: 'The identity provider is temporarily unavailable.',
      instance: '/v1/auth/oidc/callback',
      code: 'provider.unavailable',
      requestId: 'request-provider-outage',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('delegates an unmapped route failure to the matching feature error mapper', () => {
    const contexts = new RequestContextStore();
    const response = responseMock();
    const mapper = vi.fn((error: unknown) =>
      error instanceof IdentityError
        ? mapIdentityWorkspaceError(error)
        : undefined,
    );
    const filter = new ProblemDetailsFilter(contexts, undefined, [
      (_error, request) =>
        request.url?.startsWith('/v1/auth/') === true
          ? mapper(_error)
          : undefined,
    ]);

    contexts.run('request-feature-mapper', () => {
      filter.catch(
        new IdentityError('identity.provider_unavailable'),
        hostFor({ url: '/v1/auth/oidc/callback?code=secret' }, response),
      );
    });

    expect(mapper).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({
      status: 503,
      code: 'provider.unavailable',
      detail: 'The identity provider is temporarily unavailable.',
      instance: '/v1/auth/oidc/callback',
    });
  });

  it.each([
    [
      '/v1/workspaces/workspace-a/connections',
      'The connection request is invalid.',
    ],
    [
      '/v1/workspaces/workspace-a/failure-notification-destinations',
      'The connection request is invalid.',
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/failure-notification-policy',
      'The connection request is invalid.',
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/runs',
      'The workflow run request is invalid.',
    ],
    [
      '/v1/workspaces/workspace-a/runs/run-a',
      'The workflow run request is invalid.',
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/draft/nodes/node-a/test',
      'The workflow graph is invalid.',
    ],
    [
      '/v1/workspaces/workspace-a/previews/preview-a',
      'The workflow graph is invalid.',
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/draft',
      'The workflow graph is invalid.',
    ],
    ['/v1/workspaces', 'The request is invalid.'],
    ['/v1/auth/oidc/callback', 'The request is invalid.'],
  ])('preserves the feature validation problem for %s', (url, detail) => {
    const response = responseMock();
    const validationError = new z.ZodError([
      { code: 'custom', path: [], message: 'unsafe detail' },
    ]);

    new ProblemDetailsFilter(
      new RequestContextStore(),
      undefined,
      APPLICATION_ERROR_MAPPERS,
    ).catch(validationError, hostFor({ url }, response));

    expect(response.body).toMatchObject({
      status: 400,
      code: 'request.invalid',
      detail,
    });
    expect(JSON.stringify(response.body)).not.toContain('unsafe detail');
  });

  it('converts Zod issues to bounded pointer-addressed validation errors', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(contexts);
    const response = responseMock();
    const schema = z.object({
      profile: z.object({ email: z.email() }),
    });

    let validationError: unknown;
    try {
      schema.parse({ profile: { email: 'not-an-email' } });
    } catch (error: unknown) {
      validationError = error;
    }

    contexts.run('request-invalid', () => {
      filter.catch(
        validationError,
        hostFor({ url: '/v1/profile?token=secret' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.body).toMatchObject({
      type: 'urn:pertexo:problem:request.invalid',
      title: 'Invalid request',
      status: 400,
      code: 'request.invalid',
      requestId: 'request-invalid',
      instance: '/v1/profile',
      errors: [
        {
          path: '/profile/email',
          code: 'invalid_format',
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain('token=secret');
  });

  it('uses a safe fallback when a validation issue has a blank message', () => {
    const response = responseMock();
    const error = new z.ZodError([
      { code: 'custom', path: ['unsafe/key'], message: '\n' },
    ]);

    new ProblemDetailsFilter(new RequestContextStore()).catch(
      error,
      hostFor({ url: '/v1/profile' }, response),
    );

    expect(response.body).toMatchObject({
      errors: [{ path: '/unsafe~1key', message: 'Invalid value' }],
    });
  });

  it('maps Nest validation exceptions without trusting arbitrary response fields', () => {
    const contexts = new RequestContextStore();
    const logger = { log: vi.fn() };
    const filter = new ProblemDetailsFilter(contexts, logger);
    const response = responseMock();

    contexts.run('request-nest-validation', () => {
      filter.catch(
        new BadRequestException({
          statusCode: 400,
          message: ['email must be valid'],
          secret: 'must not be returned',
        }),
        hostFor({ url: '/v1/users' }, response),
      );
    });

    expect(response.body).toMatchObject({
      status: 400,
      code: 'request.invalid',
      errors: [
        { path: '', code: 'validation', message: 'email must be valid' },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain('must not be returned');
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'request.invalid',
        cause: undefined,
      }),
    );
  });

  it('omits a Nest validation issue list containing no safe strings', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      new BadRequestException({ message: [42, '\r\n'] }),
      hostFor({ url: '/v1/users' }, response),
    );

    expect(response.body).not.toHaveProperty('errors');
  });

  it('returns a generic safe 500 and logs the unknown cause', () => {
    const contexts = new RequestContextStore();
    const logger = { log: vi.fn() };
    const filter = new ProblemDetailsFilter(contexts, logger);
    const response = responseMock();

    contexts.run('request-unknown', () => {
      filter.catch(
        new Error('database password=super-secret'),
        hostFor({ url: '/v1/health' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.body).toEqual({
      type: 'urn:pertexo:problem:internal.unexpected',
      title: 'Internal server error',
      status: 500,
      instance: '/v1/health',
      code: 'internal.unexpected',
      requestId: 'request-unknown',
    });
    expect(JSON.stringify(response.body)).not.toContain('super-secret');
    expect(JSON.stringify(response.body)).not.toContain('Error');
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'internal.unexpected',
        requestId: 'request-unknown',
        severity: 'error',
      }),
    );
  });

  it.each([418, 504])(
    'preserves an explicit unmapped HTTP status %i without inventing a domain code',
    (status) => {
      const contexts = new RequestContextStore();
      const filter = new ProblemDetailsFilter(contexts);
      const response = responseMock();

      contexts.run(`request-status-${String(status)}`, () => {
        filter.catch(
          new HttpException('unsafe framework detail', status),
          hostFor({ url: '/v1/status-check' }, response),
        );
      });

      expect(response.status).toHaveBeenCalledWith(status);
      expect(response.body).toMatchObject({
        code: 'internal.unexpected',
        status,
        title: 'Internal server error',
      });
      expect(JSON.stringify(response.body)).not.toContain(
        'unsafe framework detail',
      );
    },
  );

  it.each([
    [401, 'auth.unauthenticated'],
    [403, 'auth.forbidden'],
    [404, 'resource.not_found'],
  ] as const)(
    'maps Nest status %i to %s without exposing its message',
    (status, code) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        new HttpException('unsafe framework detail', status),
        hostFor({ url: '/v1/resource' }, response),
      );

      expect(response.body).toMatchObject({ status, code });
      expect(response.body).not.toHaveProperty('errors');
      expect(JSON.stringify(response.body)).not.toContain(
        'unsafe framework detail',
      );
    },
  );

  it('normalizes invalid framework status codes to a safe 500', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      new HttpException('unsafe', 200),
      hostFor({ url: '/v1/resource' }, response),
    );

    expect(response.body).toMatchObject({
      status: 500,
      code: 'internal.unexpected',
    });
  });

  it('renders typed revision conflicts with the current strong validator', () => {
    const contexts = new RequestContextStore();
    const logger = { log: vi.fn() };
    const filter = new ProblemDetailsFilter(contexts, logger);
    const response = responseMock();

    contexts.run('request-contextual', () => {
      contexts.setActor({ actorId: 'actor-1', kind: 'user' });
      contexts.setWorkspace('11111111-1111-4111-8111-111111111111');
      filter.catch(
        applicationError('workflow.revision_conflict', {
          safeDetail: 'The draft changed.',
          details: {
            currentRevision: 2,
            currentEtag:
              '"draft-v1.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
          },
        }),
        hostFor({ url: '/v1/workflows/workflow-1' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(412);
    expect(response.header).toHaveBeenCalledWith(
      'etag',
      '"draft-v1.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
    );
    expect(response.body).toMatchObject({
      code: 'workflow.revision_conflict',
      status: 412,
      currentRevision: 2,
      currentEtag: '"draft-v1.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
    });
    expect(logger.log).toHaveBeenCalledWith({
      code: 'workflow.revision_conflict',
      requestId: 'request-contextual',
      severity: 'warn',
      actorId: 'actor-1',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      instance: '/v1/workflows/workflow-1',
      cause: undefined,
    });
  });

  it('fails malformed revision-conflict metadata closed as an internal error', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      applicationError('workflow.revision_conflict', {
        details: { currentRevision: 0, currentEtag: 'weak' },
      }),
      hostFor({ url: '/v1/workflows/workflow-1' }, response),
    );

    expect(response.body).toMatchObject({
      status: 500,
      code: 'internal.unexpected',
    });
    expect(response.header).not.toHaveBeenCalledWith('etag', expect.anything());
  });

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
});
