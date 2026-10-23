import {
  workspaceFailure,
  connectionFailure,
  runFailure,
  nodeTestingFailure,
  authoringFailure,
} from '../../../../src/problems/context/normalize.js';
import { BadRequestException } from '@nestjs/common';

import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ProblemDetailsFilter,
  RequestContextStore,
} from '../../../../src/platform/http/index.js';

import { APPLICATION_ERROR_MAPPERS } from '../../../../src/application-errors.js';

import { responseMock, hostFor } from './fixture.js';

export function registerPreservesFeatureValidationProblemS(): void {
  it.each([
    [
      '/v1/workspaces/workspace-a/connections',
      'The connection request is invalid.',
      connectionFailure,
    ],
    [
      '/v1/workspaces/workspace-a/failure-notification-destinations',
      'The connection request is invalid.',
      connectionFailure,
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/failure-notification-policy',
      'The connection request is invalid.',
      connectionFailure,
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/runs',
      'The workflow run request is invalid.',
      runFailure,
    ],
    [
      '/v1/workspaces/workspace-a/runs/run-a',
      'The workflow run request is invalid.',
      runFailure,
    ],
    [
      '/v1/workspaces/workspace-a/run-statistics',
      'The workflow run request is invalid.',
      runFailure,
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/draft/nodes/node-a/test',
      'The step test request is invalid.',
      nodeTestingFailure,
    ],
    [
      '/v1/workspaces/workspace-a/previews/preview-a',
      'The step test request is invalid.',
      nodeTestingFailure,
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/draft',
      'The workflow request is invalid.',
      authoringFailure,
    ],
    [
      '/v1/workspaces/workspace-a/workflows/workflow-a/triggers/trigger-a/schedule/disable',
      'The workflow request is invalid.',
      authoringFailure,
    ],
    ['/v1/workspaces', 'The request is invalid.', workspaceFailure],
    ['/v1/auth/oidc/callback', 'The request is invalid.', workspaceFailure],
  ])(
    'preserves the feature validation problem for %s',
    (url, detail, normalize) => {
      const response = responseMock();
      const validationError = new z.ZodError([
        { code: 'custom', path: [], message: 'unsafe detail' },
      ]);

      new ProblemDetailsFilter(
        new RequestContextStore(),
        undefined,
        APPLICATION_ERROR_MAPPERS,
      ).catch(normalize(validationError), hostFor({ url }, response));

      expect(response.body).toMatchObject({
        status: 400,
        code: 'request.invalid',
        detail,
      });
      expect(JSON.stringify(response.body)).not.toContain('unsafe detail');
    },
  );

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

  it('escapes both tilde and slash segments in validation pointers', () => {
    const response = responseMock();
    const error = new z.ZodError([
      { code: 'custom', path: ['a~b/c'], message: 'Invalid field' },
    ]);

    new ProblemDetailsFilter(new RequestContextStore()).catch(
      error,
      hostFor({ url: '/v1/profile' }, response),
    );

    expect(response.body).toMatchObject({
      errors: [{ path: '/a~0b~1c', message: 'Invalid field' }],
    });
  });

  it.each([0, 100, 101])('bounds %i validation issues at 100', (count) => {
    const response = responseMock();
    const error = new z.ZodError(
      Array.from({ length: count }, (_, index) => ({
        code: 'custom' as const,
        path: ['fields', index],
        message: `Invalid field ${String(index)}`,
      })),
    );

    new ProblemDetailsFilter(new RequestContextStore()).catch(
      error,
      hostFor({ url: '/v1/profile' }, response),
    );

    const body: unknown = response.body;
    if (typeof body !== 'object' || body === null || !('errors' in body))
      throw new Error('Problem response errors are missing');
    const errors: unknown = body.errors;
    expect(Array.isArray(errors)).toBe(true);
    if (!Array.isArray(errors))
      throw new Error('Problem errors are not an array');
    expect(errors).toHaveLength(Math.min(count, 100));
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
}
