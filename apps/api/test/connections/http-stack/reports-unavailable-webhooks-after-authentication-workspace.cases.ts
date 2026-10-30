import { connectionResponseSchema } from '@pertexo/contracts';

import { expect, it } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import {
  workspaceId,
  rawSession,
  csrf,
  credentialValue,
  destinationId,
  config,
  database,
  logger,
  rateLimitConsumer,
  telemetry,
  identityRuntime,
  connectionUrl,
  connectionPayload,
  authenticatedHeaders,
  destinationPath,
  destinationPayload,
  applicationFixture,
  start,
} from './fixture.js';

export function registerReportsUnavailableWebhooksAfterAuthenticationWorkspace(): void {
  it('reports unavailable webhooks only after authentication and workspace authorization', async () => {
    applicationFixture.application = await createTestApiApplication(config, {
      database,
      identityRuntime: identityRuntime(),
      logger,
      rateLimitConsumer,
      telemetry,
    });
    await applicationFixture.application.init();
    const parent = `/v1/workspaces/${workspaceId}/workflows/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/triggers`;
    expect(
      (
        await applicationFixture.application.inject({
          method: 'GET',
          url: parent,
        })
      ).statusCode,
    ).toBe(401);
    const unavailable = await applicationFixture.application.inject({
      method: 'GET',
      url: parent,
      headers: authenticatedHeaders,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      code: 'webhook.not_configured',
    });
    const foreign = await applicationFixture.application.inject({
      method: 'GET',
      url: parent.replace(workspaceId, '11111111-1111-4111-8111-111111111111'),
      headers: authenticatedHeaders,
    });
    expect(foreign.statusCode).toBe(404);
    const mutation = await applicationFixture.application.inject({
      method: 'POST',
      url: `${parent}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/webhook/provision`,
      headers: authenticatedHeaders,
    });
    expect(mutation.statusCode).toBe(503);
    expect(mutation.json()).toMatchObject({ code: 'webhook.not_configured' });
  });

  it('rejects unauthenticated and invalid-CSRF mutations before persistence or encryption', async () => {
    const { application, connection } = await start();
    const unauthenticated = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: { 'idempotency-key': 'create-http-stack' },
      payload: connectionPayload,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      code: 'auth.unauthenticated',
    });

    const missingCsrf = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: {
        cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
        'idempotency-key': 'create-http-stack',
      },
      payload: connectionPayload,
    });
    expect(missingCsrf.statusCode).toBe(403);

    const mismatchedCsrf = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: {
        cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
        'x-csrf-token': 'x'.repeat(32),
        'idempotency-key': 'create-http-stack',
      },
      payload: connectionPayload,
    });
    expect(mismatchedCsrf.statusCode).toBe(403);
    expect(connection.createConnection).not.toHaveBeenCalled();
    expect(connection.encryption.seal).not.toHaveBeenCalled();
  });

  it('creates and tests a connection once, replays only the same input, and omits secrets', async () => {
    const { application, connection } = await start();
    const created = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      workspaceId,
      providerKey: 'http',
      authType: 'http_headers',
      status: 'active',
    });
    expect(created.payload).not.toContain(credentialValue);
    expect(created.payload).not.toContain('credential');

    const connectionId = connectionResponseSchema.parse(created.json()).id;
    const listed = await application.inject({
      method: 'GET',
      url: `${connectionUrl}?limit=1`,
      headers: authenticatedHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [expect.objectContaining({ id: connectionId })],
      nextCursor: null,
    });
    const read = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}`,
      headers: authenticatedHeaders,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: connectionId, workspaceId });
    expect(`${listed.payload}${read.payload}`).not.toContain(credentialValue);

    const replay = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(created.json());
    expect(connection.createConnection).toHaveBeenCalledOnce();
    expect(connection.encryption.seal).toHaveBeenCalledOnce();

    const testHeaders = {
      ...authenticatedHeaders,
      'idempotency-key': 'test-http-stack',
    };
    const testPayload = { url: 'https://provider.example.test/health' };
    const tested = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connectionId}/test`,
      headers: testHeaders,
      payload: testPayload,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      connection: { id: connectionId, status: 'active' },
      outcome: { ok: true, httpStatus: 204, errorCode: null },
    });
    expect(tested.payload).not.toContain(credentialValue);
    const testReplay = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connectionId}/test`,
      headers: testHeaders,
      payload: testPayload,
    });
    expect(testReplay.statusCode).toBe(200);
    expect(testReplay.json()).toEqual(tested.json());
    expect(connection.executeHttp).toHaveBeenCalledOnce();
    expect(connection.encryption.open).toHaveBeenCalledOnce();
    expect(connection.markConnectionTestDispatched).toHaveBeenCalledOnce();
  });

  it('hides unauthenticated and cross-workspace destination mutations', async () => {
    const { application, connection } = await start();
    const unauthenticated = await application.inject({
      method: 'POST',
      url: destinationPath,
      payload: destinationPayload,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const crossWorkspace = await application.inject({
      method: 'POST',
      url: destinationPath.replace(
        workspaceId,
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ),
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'destination-hidden-wire',
      },
      payload: destinationPayload,
    });
    expect(crossWorkspace.statusCode).toBe(404);
    expect(connection.appendDestinationVersion).not.toHaveBeenCalled();
  });

  it('allows a builder to read destinations but denies destination management', async () => {
    const { application, connection } = await start('builder');
    const listed = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/failure-notification-destinations`,
      headers: authenticatedHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        expect.objectContaining({ id: destinationId, currentVersion: 2 }),
      ],
    });
    expect(connection.listDestinations).toHaveBeenCalledOnce();

    const denied = await application.inject({
      method: 'POST',
      url: destinationPath,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'destination-builder-denied',
      },
      payload: destinationPayload,
    });
    expect(denied.statusCode).toBe(404);
    expect(connection.appendDestinationVersion).not.toHaveBeenCalled();
  });
}
