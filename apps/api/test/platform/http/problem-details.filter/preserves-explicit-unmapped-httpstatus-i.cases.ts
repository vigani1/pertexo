import { HttpException } from '@nestjs/common';

import { expect, it, vi } from 'vitest';

import {
  ProblemDetailsFilter,
  RequestContextStore,
  applicationError,
} from '../../../../src/platform/http/index.js';

import { responseMock, hostFor } from './fixture.js';

export function registerPreservesExplicitUnmappedHTTPStatusI(): void {
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

  it.each([Number.NaN, 418.5])(
    'normalizes non-integer framework status %s to a safe 500',
    (status) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        new HttpException('unsafe', status),
        hostFor({ url: '/v1/resource' }, response),
      );

      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.body).toMatchObject({
        status: 500,
        code: 'internal.unexpected',
      });
    },
  );

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
            currentEtag: '"draft.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
          },
        }),
        hostFor({ url: '/v1/workflows/workflow-1' }, response),
      );
    });

    expect(response.status).toHaveBeenCalledWith(412);
    expect(response.header).toHaveBeenCalledWith(
      'etag',
      '"draft.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
    );
    expect(response.body).toMatchObject({
      code: 'workflow.revision_conflict',
      status: 412,
      currentRevision: 2,
      currentEtag: '"draft.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
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

  it.each([
    [
      'invalid revision',
      {
        currentRevision: 0,
        currentEtag: '"draft.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
      },
    ],
    ['invalid ETag', { currentRevision: 2, currentEtag: 'weak' }],
  ])(
    'fails %s conflict metadata closed as an internal error',
    (_name, details) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        applicationError('workflow.revision_conflict', {
          details,
        }),
        hostFor({ url: '/v1/workflows/workflow-1' }, response),
      );

      expect(response.body).toMatchObject({
        status: 500,
        code: 'internal.unexpected',
      });
      expect(response.header).not.toHaveBeenCalledWith(
        'etag',
        expect.anything(),
      );
    },
  );

  it.each([1, 300])('emits valid retry bound %i', (retryAfterSeconds) => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      applicationError('request.rate_limited', {
        details: { retryAfterSeconds },
      }),
      hostFor({ url: '/v1/workflows' }, response),
    );

    expect(response.header).toHaveBeenCalledWith(
      'retry-after',
      String(retryAfterSeconds),
    );
  });

  it.each([0, 301, 1.5, Number.NaN, '2'])(
    'omits invalid retry bound %j',
    (retryAfterSeconds) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        applicationError('request.rate_limited', {
          details: { retryAfterSeconds },
        }),
        hostFor({ url: '/v1/workflows' }, response),
      );

      expect(response.header).not.toHaveBeenCalledWith(
        'retry-after',
        expect.anything(),
      );
    },
  );
}
