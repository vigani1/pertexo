import { it } from 'vitest';

import { expectProblem, mutationHeaders } from '../../lifecycle.support.js';
import { lifecyclePath, fixture } from './fixture.js';

export function registerRequiresAuthenticationCSRFEachLifecycleCommand(): void {
  it('requires authentication and CSRF for each lifecycle command', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const body = { expectedLifecycleRevision: 1 };

    for (const command of ['archive', 'restore'] as const) {
      const path = lifecyclePath(workspaceId, ids.unpublished, command);
      const unauthenticated = await application.inject({
        method: 'POST',
        url: path,
        headers: { 'idempotency-key': `unauthenticated-${command}` },
        payload: body,
      });
      expectProblem(unauthenticated, 401, 'auth.unauthenticated');

      const missingCsrf = await application.inject({
        method: 'POST',
        url: path,
        headers: {
          cookie: owner.cookieHeader,
          'idempotency-key': `missing-csrf-${command}`,
        },
        payload: body,
      });
      expectProblem(missingCsrf, 403, 'auth.forbidden');
    }
  });

  it('requires one idempotency key and a strict lifecycle body', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const body = { expectedLifecycleRevision: 1 };

    for (const command of ['archive', 'restore'] as const) {
      const path = lifecyclePath(workspaceId, ids.unpublished, command);

      const missingKey = await application.inject({
        method: 'POST',
        url: path,
        headers: { cookie: owner.cookieHeader, 'x-csrf-token': owner.csrf },
        payload: body,
      });
      expectProblem(missingKey, 400, 'request.invalid');

      const combinedKey = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner, {
          'idempotency-key': `first-${command},second-${command}`,
        }),
        payload: body,
      });
      expectProblem(combinedKey, 400, 'request.invalid');

      const duplicateHeaders = await application.inject({
        method: 'POST',
        url: path,
        headers: {
          cookie: owner.cookieHeader,
          'x-csrf-token': owner.csrf,
          'idempotency-key': [
            `duplicate-one-${command}`,
            `duplicate-two-${command}`,
          ],
        },
        payload: body,
      });
      expectProblem(duplicateHeaders, 400, 'request.invalid');

      const extraBody = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner),
        payload: { ...body, unexpected: true },
      });
      expectProblem(extraBody, 400, 'request.invalid');

      const invalidRevision = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner),
        payload: { expectedLifecycleRevision: 0 },
      });
      expectProblem(invalidRevision, 400, 'request.invalid');
    }
  });

  it('rejects malformed trace context at the HTTP boundary', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    for (const traceparent of [
      'arbitrary',
      `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`,
      `00-${'1'.repeat(32)}-${'0'.repeat(16)}-01`,
    ]) {
      expectProblem(
        await application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.unpublished, 'archive'),
          headers: mutationHeaders(owner, { traceparent }),
          payload: { expectedLifecycleRevision: 1 },
        }),
        400,
        'request.invalid',
      );
    }
  });

  it('hides lifecycle commands from roles without publication authority and other tenants', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const body = { expectedLifecycleRevision: 1 };

    for (const role of ['operator', 'viewer'] as const) {
      const cookies = await fixture.login(role);
      for (const command of ['archive', 'restore'] as const) {
        const denied = await application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.unpublished, command),
          headers: mutationHeaders(cookies),
          payload: body,
        });
        expectProblem(denied, 404, 'resource.not_found');
      }
    }

    const wrongTenant = await application.inject({
      method: 'POST',
      url: lifecyclePath(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ids.unpublished,
        'archive',
      ),
      headers: mutationHeaders(owner),
      payload: body,
    });
    expectProblem(wrongTenant, 404, 'resource.not_found');
  });
}
