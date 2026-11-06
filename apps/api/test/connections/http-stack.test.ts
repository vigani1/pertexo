import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanConnectionsRealNestHTTPStackFixture,
  actorId,
  workspaceId,
  destinationId,
  config,
  database,
  logger,
  rateLimitConsumer,
  telemetry,
  identityRuntime,
  connectionUrl,
  authenticatedHeaders,
  applicationFixture,
  start,
  rawSession,
  csrf,
  credentialValue,
  connectionPayload,
  destinationPath,
  destinationPayload,
} from './http-stack/fixture.js';
import {
  ConnectionSharingRevisionConflictError,
  ConnectionNotFoundError,
} from '@pertexo/core/connections';
import { createTestApiApplication } from '../support/api-application.js';
import { connectionResponseSchema } from '@pertexo/contracts';
import { FailureNotificationDestinationError } from '@pertexo/core/notifications';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/secrets/server';

describe('connections real Nest HTTP stack', () => {
  afterEach(cleanConnectionsRealNestHTTPStackFixture);
  it('guards sharing routes before persistence, validates members and maps revision conflicts', async () => {
    const { application, connection } = await start();
    const url = `${connectionUrl}/${destinationId}/sharing`;
    expect((await application.inject({ method: 'GET', url })).statusCode).toBe(
      401,
    );
    expect(connection.readConnectionSharing).not.toHaveBeenCalled();
    const read = await application.inject({
      method: 'GET',
      url,
      headers: authenticatedHeaders,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ mode: 'restricted', revision: 2 });
    const payload = {
      mode: 'restricted',
      expectedSharingRevision: 2,
      userIds: [actorId],
    };
    expect(
      (
        await application.inject({
          method: 'POST',
          url,
          headers: { cookie: authenticatedHeaders.cookie },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await application.inject({
          method: 'POST',
          url,
          headers: authenticatedHeaders,
          payload: { ...payload, userIds: [actorId, actorId] },
        })
      ).statusCode,
    ).toBe(400);
    expect(connection.replaceConnectionSharing).not.toHaveBeenCalled();
    expect(
      (
        await application.inject({
          method: 'POST',
          url,
          headers: authenticatedHeaders,
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(connection.replaceConnectionSharing).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        connectionId: destinationId,
        request: payload,
      }),
    );
    connection.replaceConnectionSharing.mockRejectedValueOnce(
      new ConnectionSharingRevisionConflictError(),
    );
    const stale = await application.inject({
      method: 'POST',
      url,
      headers: authenticatedHeaders,
      payload,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'connection.conflict' });
  });

  it.each(['builder', 'viewer'] as const)(
    'never lets a %s administer connection sharing',
    async (role) => {
      const { application, connection } = await start(role);
      const url = `${connectionUrl}/${destinationId}/sharing`;
      expect(
        (
          await application.inject({
            method: 'GET',
            url,
            headers: authenticatedHeaders,
          })
        ).statusCode,
      ).toBe(404);
      expect(connection.readConnectionSharing).not.toHaveBeenCalled();
    },
  );

  it('reports unconfigured connections only to an eligible workspace reader', async () => {
    applicationFixture.application = await createTestApiApplication(config, {
      database,
      identityRuntime: identityRuntime(),
      logger,
      rateLimitConsumer,
      telemetry,
    });
    await applicationFixture.application.init();
    for (const resource of [
      'connections',
      'failure-notification-destinations',
    ]) {
      const url = `/v1/workspaces/${workspaceId}/${resource}`;
      expect(
        (await applicationFixture.application.inject({ method: 'GET', url }))
          .statusCode,
      ).toBe(401);
      const configured = await applicationFixture.application.inject({
        method: 'GET',
        url,
        headers: authenticatedHeaders,
      });
      expect(configured.statusCode).toBe(503);
      expect(configured.json()).toMatchObject({
        code: 'connection.not_configured',
      });
      const foreign = await applicationFixture.application.inject({
        method: 'GET',
        url: `/v1/workspaces/11111111-1111-4111-8111-111111111111/${resource}`,
        headers: authenticatedHeaders,
      });
      expect(foreign.statusCode).toBe(404);
    }
  });

  it('reports disabled file storage after session, workspace, upload-role and CSRF checks', async () => {
    applicationFixture.application = await createTestApiApplication(config, {
      database,
      identityRuntime: identityRuntime(),
      logger,
      rateLimitConsumer,
      telemetry,
    });
    await applicationFixture.application.init();
    for (const [method, suffix] of [
      ['GET', destinationId],
      ['GET', `${destinationId}/download`],
      ['POST', 'uploads'],
      ['POST', `${destinationId}/finalize`],
    ] as const) {
      const url = `/v1/workspaces/${workspaceId}/artifacts/${suffix}`;
      const payload = method === 'POST' ? {} : undefined;
      expect(
        (
          await applicationFixture.application.inject({
            method,
            url,
            ...(payload ? { payload } : {}),
          })
        ).statusCode,
      ).toBe(401);
      const result = await applicationFixture.application.inject({
        method,
        url,
        headers: authenticatedHeaders,
        ...(payload ? { payload } : {}),
      });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toMatchObject({
        code: 'artifact.unavailable',
      });
      expect(result.body).toContain('ARTIFACT_STORE_*');
      expect(
        (
          await applicationFixture.application.inject({
            method,
            url: `/v1/workspaces/11111111-1111-4111-8111-111111111111/artifacts/${suffix}`,
            headers: authenticatedHeaders,
            ...(payload ? { payload } : {}),
          })
        ).statusCode,
      ).toBe(404);
    }
    const noCsrf = await applicationFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/artifacts/uploads`,
      headers: { cookie: authenticatedHeaders.cookie },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('keeps disabled-storage upload routes denied to viewers', async () => {
    applicationFixture.application = await createTestApiApplication(config, {
      database,
      identityRuntime: identityRuntime('viewer'),
      logger,
      rateLimitConsumer,
      telemetry,
    });
    await applicationFixture.application.init();
    const result = await applicationFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/artifacts/uploads`,
      headers: authenticatedHeaders,
      payload: {},
    });
    expect(result.statusCode).toBe(404);
  });

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
      nextCursor: null,
      items: [
        expect.objectContaining({ id: destinationId, currentVersion: 2 }),
      ],
      nextCursor: null,
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

  it('reads the workflow failure-alert policy as a builder, never for a viewer', async () => {
    const policyUrl = `/v1/workspaces/${workspaceId}/workflows/ffffffff-ffff-4fff-8fff-ffffffffffff/failure-notification-policy`;
    const builder = await start('builder');
    const current = await builder.application.inject({
      method: 'GET',
      url: policyUrl,
      headers: authenticatedHeaders,
    });
    expect(current.statusCode, current.payload).toBe(200);
    expect(current.json()).toEqual({
      destination: {
        id: destinationId,
        workspaceId,
        kind: 'slack',
        status: 'enabled',
        currentVersion: 2,
        config: {
          kind: 'slack',
          connectionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          channelId: 'C67890',
        },
        createdAt: '2026-08-22T12:00:00.000Z',
        updatedAt: '2026-08-22T12:01:00.000Z',
      },
    });
    builder.connection.getWorkflowPolicy.mockRejectedValueOnce(
      new FailureNotificationDestinationError(
        'not_found',
        'raw hidden workflow detail',
      ),
    );
    const hidden = await builder.application.inject({
      method: 'GET',
      url: policyUrl,
      headers: authenticatedHeaders,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.payload).not.toContain('raw hidden workflow detail');
    await builder.application.close();
    applicationFixture.application = undefined;

    const viewer = await start('viewer');
    const denied = await viewer.application.inject({
      method: 'GET',
      url: policyUrl,
      headers: authenticatedHeaders,
    });
    expect(denied.statusCode).toBe(404);
    expect(viewer.connection.getWorkflowPolicy).not.toHaveBeenCalled();
  });

  it('denies a viewer destination reads before persistence', async () => {
    const { application, connection } = await start('viewer');
    const denied = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/failure-notification-destinations`,
      headers: authenticatedHeaders,
    });
    expect(denied.statusCode).toBe(404);
    expect(connection.listDestinations).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)(
    'allows a %s to append a destination version',
    async (role) => {
      const { application, connection } = await start(role);
      const appended = await application.inject({
        method: 'POST',
        url: destinationPath,
        headers: {
          ...authenticatedHeaders,
          'idempotency-key': `destination-${role}-append`,
        },
        payload: destinationPayload,
      });
      expect(appended.statusCode).toBe(200);
      expect(appended.json()).toMatchObject({
        id: destinationId,
        currentVersion: 2,
      });
      expect(connection.appendDestinationVersion).toHaveBeenCalledOnce();
    },
  );

  it('maps hidden destination reads and conflicts to public HTTP errors', async () => {
    const { application, connection } = await start();
    connection.getDestination.mockRejectedValueOnce(
      new FailureNotificationDestinationError(
        'not_found',
        'raw hidden destination detail',
      ),
    );
    const hidden = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}`,
      headers: authenticatedHeaders,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'resource.not_found' });
    expect(hidden.payload).not.toContain('raw hidden destination detail');

    connection.appendDestinationVersion.mockRejectedValueOnce(
      new FailureNotificationDestinationError(
        'conflict',
        'raw destination version detail',
      ),
    );
    const conflict = await application.inject({
      method: 'POST',
      url: destinationPath,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'destination-conflict-wire',
      },
      payload: destinationPayload,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'connection.conflict' });
    expect(conflict.payload).not.toContain('raw destination version detail');
  });

  it('does not serialize raw credential-protection causes', async () => {
    const { application, connection } = await start();
    const failure = new ConnectionSecretEncryptionError();
    Object.defineProperty(failure, 'cause', {
      value: new Error('Bearer raw-kms-credential'),
    });
    connection.encryption.seal.mockRejectedValueOnce(failure);
    const response = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'provider.unavailable' });
    expect(response.payload).not.toContain('raw-kms-credential');
    expect(response.payload).not.toContain(credentialValue);
  });

  it('exposes bounded published usage to viewers without CSRF or credential fields', async () => {
    const { application, connection } = await start('viewer');
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const workflowVersionId = '22222222-2222-4222-8222-222222222222';
    connection.listConnectionUsage.mockResolvedValueOnce({
      items: [
        {
          workflowId: '33333333-3333-4333-8333-333333333333',
          workflowName: 'Historical sender',
          workflowLifecycleStatus: 'archived',
          workflowVersionId,
          versionNumber: 2,
          isCurrentPublication: false,
          operationKeys: ['send_message'],
        },
      ],
      nextCursor: { workflowVersionId },
    });
    const response = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}/usage?limit=1`,
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          workflowLifecycleStatus: 'archived',
          versionNumber: 2,
          isCurrentPublication: false,
        },
      ],
    });
    expect(connection.listConnectionUsage).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      actorId,
      connectionId,
      limit: 1,
    });
    expect(response.payload).not.toMatch(
      /secretVersion|credential|graph_json/iu,
    );
    const cursor = response.json<{ nextCursor: string }>().nextCursor;
    const swapped = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${workflowVersionId}/usage?after=${cursor}`,
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(swapped.statusCode).toBe(400);
    expect(connection.listConnectionUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps usage nondisclosing across authentication, workspace and database authority failures', async () => {
    const { application, connection } = await start();
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const unauthenticated = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}/usage`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const foreign = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${connectionId}/connections/${connectionId}/usage`,
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(connection.listConnectionUsage).not.toHaveBeenCalled();
    connection.listConnectionUsage.mockRejectedValueOnce(
      new ConnectionNotFoundError('internal private usage'),
    );
    const revoked = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}/usage`,
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.payload).not.toContain('internal private usage');
    const unbounded = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}/usage?limit=101`,
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(unbounded.statusCode).toBe(400);
    expect(connection.listConnectionUsage).toHaveBeenCalledTimes(1);
  });

  it('does not serialize raw provider failure causes', async () => {
    const { application, connection } = await start();
    const created = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
    });
    const connectionId = connectionResponseSchema.parse(created.json()).id;
    const providerFailure = new SecureHttpError(
      SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
      'definite_failure',
      { possiblyDispatched: false },
    );
    Object.defineProperty(providerFailure, 'cause', {
      value: new Error('provider body with raw-secret'),
    });
    connection.executeHttp.mockRejectedValueOnce(providerFailure);
    const response = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connectionId}/test`,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'test-provider-cause',
      },
      payload: { url: 'https://provider.example.test/health' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'provider.unavailable' });
    expect(response.payload).not.toContain('provider body with raw-secret');
    expect(response.payload).not.toContain(credentialValue);
  });
});
