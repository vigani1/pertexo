import {
  WebhookTriggerNotFoundError,
  type WebhookDeliveryPage,
  type WebhookTriggerDatabase,
} from '@pertexo/database/testing';
import { webhookDeliveryListResponseSchema } from '@pertexo/contracts/webhooks';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import {
  decodeWebhookDeliveryCursor,
  encodeWebhookDeliveryCursor,
} from '../../src/webhooks/cursor.js';
import { WebhookManagementService } from '../../src/webhooks/service.js';

const scope = {
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  triggerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const position = {
  receivedAt: '2026-09-25T10:00:00.123456Z',
  id: '11111111-1111-4111-8111-111111111111',
};
const page: WebhookDeliveryPage = {
  items: [
    {
      id: position.id,
      receivedAt: position.receivedAt,
      outcome: 'replayed',
      httpStatus: 202,
      signatureCheck: 'verified',
      replayCheck: 'duplicate',
      bodyBytes: 64,
      runId: '99999999-9999-4999-8999-999999999999',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      receivedAt: '2026-09-25T09:59:00.000000Z',
      outcome: 'authentication_failed',
      httpStatus: 401,
      signatureCheck: 'mismatch',
      replayCheck: 'not_checked',
      bodyBytes: null,
      runId: null,
    },
  ],
  nextCursor: position,
};

function service(listDeliveries: WebhookTriggerDatabase['listDeliveries']) {
  return new WebhookManagementService(
    { listDeliveries } as unknown as WebhookTriggerDatabase,
    {} as WebhookTriggerEnvelopeEncryption,
  );
}

describe('webhook delivery log read', () => {
  it('projects metadata and continues only the same trigger', async () => {
    const listDeliveries = vi
      .fn<WebhookTriggerDatabase['listDeliveries']>()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ items: [] });
    const reader = service(listDeliveries);

    const first = await reader.listDeliveries({ ...scope, limit: 2 });
    expect(webhookDeliveryListResponseSchema.parse(first)).toEqual(first);
    expect(first.items).toEqual([
      {
        id: position.id,
        receivedAt: position.receivedAt,
        outcome: 'replayed',
        httpStatus: 202,
        signatureCheck: 'verified',
        replayCheck: 'duplicate',
        byteLength: 64,
        runId: '99999999-9999-4999-8999-999999999999',
      },
      expect.objectContaining({ byteLength: null, runId: null }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(listDeliveries).toHaveBeenLastCalledWith({ ...scope, limit: 2 });

    const second = await reader.listDeliveries({
      ...scope,
      after: first.nextCursor ?? '',
    });
    expect(second).toEqual({ items: [], nextCursor: null });
    expect(listDeliveries).toHaveBeenLastCalledWith({
      ...scope,
      after: position,
    });
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    [
      'another trigger',
      encodeWebhookDeliveryCursor(
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        position,
      ),
    ],
  ])('rejects a %s cursor before reading', async (_label, after) => {
    const listDeliveries = vi.fn<WebhookTriggerDatabase['listDeliveries']>();

    await expect(
      service(listDeliveries).listDeliveries({ ...scope, after }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    expect(listDeliveries).not.toHaveBeenCalled();
  });

  it('hides an invisible trigger behind not found', async () => {
    const reader = service(
      vi
        .fn<WebhookTriggerDatabase['listDeliveries']>()
        .mockRejectedValue(new WebhookTriggerNotFoundError()),
    );

    await expect(reader.listDeliveries(scope)).rejects.toMatchObject({
      code: 'resource.not_found',
    });
  });

  it('round-trips an exact microsecond position', () => {
    const cursor = encodeWebhookDeliveryCursor(scope.triggerId, position);

    expect(decodeWebhookDeliveryCursor(cursor, scope.triggerId)).toEqual(
      position,
    );
    expect(cursor).not.toContain(position.id);
  });
});
