import { ConnectionSharingRevisionConflictError } from '@pertexo/database/connections';

import { expect, it } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import {
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
} from './fixture.js';

export function registerGuardsSharingRoutesBeforePersistenceValidates(): void {
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
}
