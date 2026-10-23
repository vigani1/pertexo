import { BadRequestException } from '@nestjs/common';

import { expect, it, vi } from 'vitest';

import {
  ProblemDetailsFilter,
  RequestContextStore,
  applicationError,
} from '../../../../src/platform/http/index.js';

import { responseMock, hostFor } from './fixture.js';

export function registerOmitsNestValidationIssueListContaining(): void {
  it('omits a Nest validation issue list containing no safe strings', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      new BadRequestException({ message: [42, '\r\n'] }),
      hostFor({ url: '/v1/users' }, response),
    );

    expect(response.body).not.toHaveProperty('errors');
  });

  it('treats work stopped by a closed browser request as expected, not a failure', () => {
    const contexts = new RequestContextStore();
    const logger = { log: vi.fn() };
    const filter = new ProblemDetailsFilter(contexts, logger);
    const aborted = Object.assign(new Error('Workspace transaction aborted'), {
      name: 'AbortError',
    });
    const closed = responseMock();
    contexts.run('request-closed', () => {
      filter.catch(
        aborted,
        hostFor({ url: '/v1/workspaces', raw: { destroyed: true } }, closed),
      );
    });
    expect(closed.status).toHaveBeenCalledWith(499);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'request.aborted', severity: 'info' }),
    );
    // A server-side abort while the browser still waits stays a failure.
    const open = responseMock();
    contexts.run('request-open', () => {
      filter.catch(aborted, hostFor({ url: '/v1/workspaces' }, open));
    });
    expect(open.status).toHaveBeenCalledWith(500);
  });

  it('treats a closed request as expected when an area mapper wrapped its abort', () => {
    const contexts = new RequestContextStore();
    const logger = { log: vi.fn() };
    const filter = new ProblemDetailsFilter(contexts, logger);
    // What an area's error mapper throws for an error it doesn't recognise.
    const wrapped = applicationError('internal.unexpected', {
      cause: new DOMException('Request aborted', 'AbortError'),
    });
    const closed = responseMock();
    contexts.run('request-closed', () => {
      filter.catch(
        wrapped,
        hostFor({ url: '/v1/workspaces', raw: { destroyed: true } }, closed),
      );
    });
    expect(closed.status).toHaveBeenCalledWith(499);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'request.aborted', severity: 'info' }),
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

  it.each([
    [
      'throwing has trap',
      () =>
        new Proxy(
          {},
          {
            has: () => {
              throw new Error('hostile has trap');
            },
          },
        ),
    ],
    [
      'throwing get trap',
      () =>
        new Proxy(
          { code: 'request.invalid' },
          {
            get: () => {
              throw new Error('hostile get trap');
            },
          },
        ),
    ],
    [
      'throwing getOwnPropertyDescriptor trap',
      () =>
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error('hostile descriptor trap');
            },
          },
        ),
    ],
    [
      'throwing getPrototypeOf trap',
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf: () => {
              throw new Error('hostile prototype trap');
            },
          },
        ),
    ],
    [
      'known code with throwing metadata getter',
      () => {
        const value = { code: 'request.invalid' };
        Object.defineProperty(value, 'safeDetail', {
          get: () => {
            throw new Error('hostile safe detail getter');
          },
        });
        return value;
      },
    ],
    [
      'revoked proxy',
      () => {
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        return revocable.proxy;
      },
    ],
  ] as const)('fails closed for a %s', (_label, createException) => {
    const response = responseMock();
    const logger = { log: vi.fn() };
    const exception = createException();

    new ProblemDetailsFilter(new RequestContextStore(), logger).catch(
      exception,
      hostFor({ url: '/v1/hostile' }, response),
    );

    expect(response.status).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.send).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({
      code: 'internal.unexpected',
      status: 500,
    });
    expect(logger.log).toHaveBeenCalledOnce();
    const logged: unknown = logger.log.mock.calls[0]?.[0];
    if (typeof logged !== 'object' || logged === null || !('cause' in logged))
      throw new Error('Logged problem cause is missing');
    expect(logged.cause).toBe(exception);
  });

  it('fails closed when an injected feature mapper throws', () => {
    const response = responseMock();
    const cause = new Error('private mapper input');
    const mapper = vi.fn(() => {
      throw new Error('mapper failed');
    });

    new ProblemDetailsFilter(new RequestContextStore(), undefined, [
      mapper,
    ]).catch(cause, hostFor({ url: '/v1/mapper' }, response));

    expect(mapper).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.send).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({
      code: 'internal.unexpected',
      status: 500,
    });
  });
}
