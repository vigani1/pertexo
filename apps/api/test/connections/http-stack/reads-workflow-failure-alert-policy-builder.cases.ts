import { FailureNotificationDestinationError } from '@pertexo/core/notifications';

import { ConnectionSecretEncryptionError } from '@pertexo/integrations/server';
import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  credentialValue,
  destinationId,
  connectionUrl,
  connectionPayload,
  authenticatedHeaders,
  destinationPath,
  destinationPayload,
  applicationFixture,
  start,
} from './fixture.js';

export function registerReadsWorkflowFailureAlertPolicyBuilder(): void {
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
}
