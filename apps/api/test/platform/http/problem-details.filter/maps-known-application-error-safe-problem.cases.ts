import { toProblem } from '../../../../src/problems/registry.js';
import { workspaceFailure } from '../../../../src/problems/context/normalize.js';

import { apiProblemSchema } from '@pertexo/contracts';
import { expect, it, vi } from 'vitest';

import {
  ProblemDetailsFilter,
  RequestContextStore,
  applicationError,
} from '../../../../src/platform/http/index.js';
import { IdentityError } from '../../../../src/identity/index.js';

import { responseMock, hostFor } from './fixture.js';

export function registerMapsKnownApplicationErrorSafeProblem(): void {
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

  it('delegates an unmapped route failure to the matching feature error mapper', () => {
    const contexts = new RequestContextStore();
    const response = responseMock();
    const mapper = vi.fn((error: unknown) =>
      error instanceof IdentityError
        ? toProblem(workspaceFailure(error))
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
        new IdentityError('identity.csrf_failed'),
        hostFor({ url: '/v1/auth/logout?token=secret' }, response),
      );
    });

    expect(mapper).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({
      status: 403,
      code: 'auth.forbidden',
      detail: 'The request could not be verified.',
      instance: '/v1/auth/logout',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
}
