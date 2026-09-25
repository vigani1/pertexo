import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../src/identity-workspace/index.js';
import type { IdentityWorkspaceRequest } from '../../src/identity-workspace/types.js';
import { WebhookManagementController } from '../../src/webhooks/controllers.js';
import {
  WebhookReadGuard,
  WebhookUpdateGuard,
} from '../../src/webhooks/guards.js';
import type { WebhookManagementService } from '../../src/webhooks/service.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const triggerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const endpointKey = 'a'.repeat(43);

function request(
  idempotency: unknown = 'webhook-command',
): IdentityWorkspaceRequest {
  return {
    headers: { 'idempotency-key': idempotency },
    identitySession: {
      userId: actorId,
      sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expiresAt: new Date('2026-08-25T13:00:00.000Z'),
      clientMetadata: {},
    },
  } as IdentityWorkspaceRequest;
}

function fixture() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    listDeliveries: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    provision: vi.fn().mockResolvedValue({ ok: true }),
    rotateEndpoint: vi.fn().mockResolvedValue({ ok: true }),
    rotateSecret: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    controller: new WebhookManagementController(
      service as unknown as WebhookManagementService,
    ),
    service,
  };
}

describe('webhook management controller public seam', () => {
  it('forwards the workflow parent and authenticated actor for list', async () => {
    const { controller, service } = fixture();

    await controller.list(request(), { workspaceId, workflowId });

    expect(service.list).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
    });
  });

  it('forwards a bounded delivery page for one trigger of the workflow', async () => {
    const { controller, service } = fixture();
    const route = { workspaceId, workflowId, triggerId };

    await controller.deliveries(request(), route, undefined);
    await controller.deliveries(request(), route, {
      limit: '50',
      after: 'opaque',
    });

    expect(service.listDeliveries.mock.calls).toEqual([
      [{ ...route, actorId }],
      [{ ...route, actorId, limit: 50, after: 'opaque' }],
    ]);
    for (const query of [{ limit: '0' }, { limit: '101' }, { cursor: 'x' }])
      expect(() => controller.deliveries(request(), route, query)).toThrow();
    expect(service.listDeliveries).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['provision', undefined],
    ['rotateEndpoint', undefined],
    ['rotateSecret', endpointKey],
  ] as const)(
    'forwards %s with exactly its required material',
    async (method, suppliedEndpoint) => {
      const { controller, service } = fixture();
      const route = { workspaceId, workflowId, triggerId };

      if (method === 'rotateSecret')
        await controller.rotateSecret(request(), route, {
          endpointKey: suppliedEndpoint,
        });
      else await controller[method](request(), route);

      const command: Record<string, unknown> = service[method].mock
        .calls[0]?.[0] as Record<string, unknown>;
      expect(command).toMatchObject({
        workspaceId,
        workflowId,
        triggerId,
        actorId,
        idempotencyKey: 'webhook-command',
      });
      expect(command.signal).toBeInstanceOf(AbortSignal);
      expect(Object.hasOwn(command, 'endpointKey')).toBe(
        method === 'rotateSecret',
      );
    },
  );

  it('rejects missing rotate-secret endpoint material before the service', () => {
    const { controller, service } = fixture();

    expect(() =>
      controller.rotateSecret(
        request(),
        { workspaceId, workflowId, triggerId },
        {},
      ),
    ).toThrow();
    expect(service.rotateSecret).not.toHaveBeenCalled();
  });

  it.each([undefined, ['first', 'second'], 'first,second'])(
    'rejects malformed idempotency %j before mutation',
    async (value) => {
      const { controller, service } = fixture();

      await expect(
        controller.provision(
          value === undefined ? { ...request(), headers: {} } : request(value),
          {
            workspaceId,
            workflowId,
            triggerId,
          },
        ),
      ).rejects.toMatchObject({ name: 'InvalidIdempotencyKeyError' });
      expect(service.provision).not.toHaveBeenCalled();
    },
  );

  it('keeps read and mutation guards in the reviewed order', () => {
    const reflector = new Reflector();
    for (const method of ['list', 'deliveries'] as const)
      expect(guards(reflector, method)).toEqual([
        SessionAuthenticationGuard,
        WebhookReadGuard,
      ]);
    for (const method of [
      'provision',
      'rotateEndpoint',
      'rotateSecret',
    ] as const)
      expect(guards(reflector, method)).toEqual([
        SessionAuthenticationGuard,
        WebhookUpdateGuard,
        CsrfProtectionGuard,
      ]);
  });
});

function guards(
  reflector: Reflector,
  method:
    'deliveries' | 'list' | 'provision' | 'rotateEndpoint' | 'rotateSecret',
): unknown[] {
  const candidate: unknown = Object.getOwnPropertyDescriptor(
    WebhookManagementController.prototype,
    method,
  )?.value as unknown;
  if (typeof candidate !== 'function')
    throw new Error(`Webhook controller handler ${method} is missing`);
  return reflector.getAllAndMerge<unknown[]>(GUARDS_METADATA, [
    candidate,
    WebhookManagementController,
  ]);
}
