import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { issueBrowserSession } from '../support/browser-session.fixture.js';

import {
  identityRuntime,
  service,
  application,
  consume,
  origin,
  seedWebhook,
  ownerQuery,
} from './fixture.js';

export function registerConfiguresModesThroughAuthenticatedHTTPQualifies(): void {
  it('configures modes through authenticated HTTP and qualifies real CORS, deduplication and rotation', async () => {
    const seeded = await seedWebhook('authentication-modes');
    const session = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      seeded.actorId,
    );
    const path = `/v1/workspaces/${seeded.workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/authentication`;
    const browserOrigin = 'https://browser.example';
    const commandKey = randomUUID();
    const headers = {
      cookie: session.cookieHeader,
      'x-csrf-token': session.csrf,
      'idempotency-key': commandKey,
    };
    const policy = { mode: 'secret_url', allowedOrigins: [browserOrigin] };
    const denied = await application.inject({
      method: 'POST',
      url: path,
      headers: {
        cookie: session.cookieHeader,
        'idempotency-key': randomUUID(),
      },
      payload: policy,
    });
    expect(denied.statusCode).toBe(403);
    const configured = await application.inject({
      method: 'POST',
      url: path,
      headers,
      payload: policy,
    });
    expect(configured.statusCode, configured.body).toBe(200);
    const result = configured.json<{
      endpointKey: string;
      signingSecret?: string;
      replayed: boolean;
    }>();
    expect(result.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.signingSecret).toBeUndefined();
    expect(
      (
        await application.inject({
          method: 'POST',
          url: path,
          headers,
          payload: policy,
        })
      ).json(),
    ).toMatchObject({ replayed: true });
    const endpoint = new URL(`/hooks/${result.endpointKey}`, origin);
    const preflight = await fetch(endpoint, {
      method: 'OPTIONS',
      headers: {
        origin: browserOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, idempotency-key',
      },
      signal: AbortSignal.timeout(5000),
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      browserOrigin,
    );
    expect(
      preflight.headers.get('access-control-allow-credentials'),
    ).toBeNull();
    await preflight.arrayBuffer();
    expect(
      consume.mock.calls.some(
        ([decision]) =>
          decision.endpointClass === 'webhook_preflight' &&
          decision.dimensions.some(
            (dimension) =>
              dimension.kind === 'client_address' && dimension.limit === 60,
          ),
      ),
    ).toBe(true);
    consume.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 5,
      limitedDimension: 'client_address',
    });
    const limitedPreflight = await fetch(endpoint, {
      method: 'OPTIONS',
      headers: {
        origin: browserOrigin,
        'access-control-request-method': 'POST',
      },
      signal: AbortSignal.timeout(5000),
    });
    expect(limitedPreflight.status).toBe(429);
    expect(limitedPreflight.headers.get('retry-after')).toBe('5');
    await limitedPreflight.arrayBuffer();

    const key = randomUUID();
    const send = (target: URL, extra: Record<string, string> = {}) =>
      fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          ...extra,
        },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
    const accepted = await send(endpoint, { origin: browserOrigin });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('access-control-allow-origin')).toBe(
      browserOrigin,
    );
    const receipt: unknown = await accepted.json();
    const duplicate = await send(endpoint, { origin: browserOrigin });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({
      ...(receipt as object),
      replayed: true,
    });
    const unlisted = await send(endpoint, { origin: 'https://other.example' });
    expect(unlisted.status).toBe(401);
    expect(unlisted.headers.get('access-control-allow-origin')).toBeNull();
    await unlisted.arrayBuffer();
    const old = await send(new URL(`/hooks/${seeded.endpointKey}`, origin));
    expect(old.status).toBe(401);
    await old.arrayBuffer();
    const next = await application.inject({
      method: 'POST',
      url: path,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: {
        mode: 'header_secret',
        headerName: 'authorization',
        allowedOrigins: [browserOrigin],
      },
    });
    expect(next.statusCode).toBe(200);
    const material = next.json<{
      endpointKey: string;
      signingSecret: string;
    }>();
    const target = new URL(`/hooks/${material.endpointKey}`, origin);
    const missing = await send(target);
    expect(missing.status).toBe(401);
    await missing.arrayBuffer();
    const valid = await send(target, {
      authorization: `Bearer ${material.signingSecret}`,
      origin: browserOrigin,
    });
    expect(valid.status).toBe(202);
    await valid.arrayBuffer();
    const beforeRotation = material.signingSecret;
    const rotated = await service.rotateSecret({
      ...seeded,
      triggerId: seeded.trigger.id,
      idempotencyKey: randomUUID(),
      endpointKey: material.endpointKey,
    });
    expect(rotated.replayed).toBe(false);
    const overlap = await send(target, {
      authorization: `Bearer ${beforeRotation}`,
    });
    expect(overlap.status).toBe(202);
    await overlap.arrayBuffer();
    const changedUrl = await send(endpoint);
    expect(changedUrl.status).toBe(401);
    await changedUrl.arrayBuffer();
    const counts = await ownerQuery<{ count: number }>(
      'select count(*)::int count from app.workflow_runs where workflow_id=$1',
      [seeded.workflowId],
    );
    expect(counts.rows[0]?.count).toBe(1);
    const allowance = await ownerQuery<{ request_count: number }>(
      `select allowance.request_count from app.webhook_endpoint_ingress_limits allowance
       join app.webhook_trigger_endpoints endpoint on endpoint.id=allowance.endpoint_id
       where endpoint.workflow_id=$1`,
      [seeded.workflowId],
    );
    expect(allowance.rows[0]?.request_count).toBe(6);
  });
}
