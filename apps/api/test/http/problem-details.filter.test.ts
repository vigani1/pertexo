import { BadRequestException, HttpException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ProblemDetailsFilter,
  RequestContextStore,
  applicationError,
} from '../../src/platform/http/index.js';

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
  request: Readonly<{ url?: string }>,
  response: ResponseMock,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('RFC 9457 problem details filter', () => {
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

  it('logs safe catalog problems at their declared severity with context', () => {
    const contexts = new RequestContextStore();
    const logger = { log: vi.fn() };
    const filter = new ProblemDetailsFilter(contexts, logger);
    const response = responseMock();

    contexts.run('request-contextual', () => {
      contexts.setActor({ actorId: 'actor-1', kind: 'user' });
      contexts.setWorkspace('11111111-1111-4111-8111-111111111111');
      filter.catch(
        applicationError('workflow.revision_conflict'),
        hostFor({ url: '/v1/workflows/workflow-1' }, response),
      );
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
});
