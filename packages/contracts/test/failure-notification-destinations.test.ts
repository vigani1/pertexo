import { describe, expect, it } from 'vitest';
import { FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT } from '@pertexo/workflow-model/failure-notification';

import {
  failureNotificationDestinationAppendVersionRequestSchema,
  failureNotificationDestinationCreateRequestSchema,
  failureNotificationDestinationListResponseSchema,
} from '../src/http/failure-notification-destinations.js';
import {
  connectionsClientContract,
  connectionsOpenApiDocument,
} from '../src/connections.js';

describe('failure notification destination contracts', () => {
  it('accepts only the canonical Slack and normalized email configurations', () => {
    expect(
      failureNotificationDestinationCreateRequestSchema.parse({
        kind: 'slack',
        connectionId: '11111111-1111-4111-8111-111111111111',
        channelId: 'C12345',
      }),
    ).toMatchObject({ kind: 'slack', channelId: 'C12345' });
    expect(
      failureNotificationDestinationCreateRequestSchema.parse({
        kind: 'email',
        connectionId: '11111111-1111-4111-8111-111111111111',
        toEmail: 'Ops@EXAMPLE.TEST',
      }),
    ).toMatchObject({ toEmail: 'Ops@example.test' });
  });

  it('rejects secret fields, mixed kinds, and invalid optimistic versions', () => {
    expect(
      failureNotificationDestinationCreateRequestSchema.safeParse({
        kind: 'slack',
        connectionId: '11111111-1111-4111-8111-111111111111',
        channelId: 'C12345',
        botToken: 'xoxb-secret',
      }).success,
    ).toBe(false);
    expect(
      failureNotificationDestinationAppendVersionRequestSchema.safeParse({
        expectedVersion: 0,
        config: {
          kind: 'email',
          connectionId: '11111111-1111-4111-8111-111111111111',
          channelId: 'C12345',
        },
      }).success,
    ).toBe(false);
  });

  it('publishes every destination command with command-only idempotency', () => {
    const paths = connectionsOpenApiDocument.paths;
    const collection =
      paths['/v1/workspaces/{workspaceId}/failure-notification-destinations'];
    const policy =
      paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/failure-notification-policy'
      ];
    expect(collection.post.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key' }),
      ]),
    );
    expect(collection.get.parameters).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key' }),
      ]),
    );
    expect(policy.put.responses).toHaveProperty('204');
    expect(policy.delete.responses).toHaveProperty('204');
    expect(connectionsClientContract.schemas).toHaveProperty(
      'FailureNotificationDestinationResponse',
    );
  });

  it('matches the database-owned destination page bound', () => {
    const destination = {
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      kind: 'slack' as const,
      status: 'enabled' as const,
      currentVersion: 1,
      config: {
        kind: 'slack' as const,
        connectionId: '33333333-3333-4333-8333-333333333333',
        channelId: 'C12345',
      },
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };

    expect(
      failureNotificationDestinationListResponseSchema.safeParse({
        items: Array.from(
          { length: FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT },
          () => destination,
        ),
      }).success,
    ).toBe(true);
    expect(
      failureNotificationDestinationListResponseSchema.safeParse({
        items: Array.from(
          { length: FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT + 1 },
          () => destination,
        ),
      }).success,
    ).toBe(false);
  });
});
