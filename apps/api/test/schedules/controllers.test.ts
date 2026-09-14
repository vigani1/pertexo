import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../src/identity-workspace/index.js';
import type { IdentityWorkspaceRequest } from '../../src/identity-workspace/types.js';
import { ScheduleManagementController } from '../../src/schedules/controllers.js';
import {
  ScheduleReadGuard,
  ScheduleUpdateGuard,
} from '../../src/schedules/guards.js';
import type { ScheduleManagementService } from '../../src/schedules/service.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const triggerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function request(
  idempotency: unknown = 'schedule-command',
): IdentityWorkspaceRequest {
  return {
    requestId: 'request-1',
    traceId: 'trace-1',
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
    setEnabled: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    controller: new ScheduleManagementController(
      service as unknown as ScheduleManagementService,
    ),
    service,
  };
}

describe('schedule management controller public seam', () => {
  it('forwards list route identifiers and the authenticated actor', async () => {
    const { controller, service } = fixture();

    await controller.list(request(), { workspaceId, workflowId });

    expect(service.list).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
    });
  });

  it.each([
    ['enable', true],
    ['disable', false],
  ] as const)('validates and forwards %s once', async (method, enabled) => {
    const { controller, service } = fixture();

    await controller[method](
      request(),
      { workspaceId, workflowId, triggerId },
      {},
    );

    expect(service.setEnabled).toHaveBeenCalledExactlyOnceWith(
      {
        workspaceId,
        workflowId,
        triggerId,
        actorId,
        idempotencyKey: 'schedule-command',
        requestId: 'request-1',
        traceId: 'trace-1',
      },
      enabled,
    );
  });

  it.each([
    [undefined, 'request.precondition_required'],
    [['first', 'second'], 'request.invalid'],
    ['first,second', 'request.invalid'],
  ])(
    'rejects required or malformed idempotency %j before mutation',
    async (value, code) => {
      const { controller, service } = fixture();
      let failure: unknown;
      try {
        await controller.enable(
          value === undefined ? { ...request(), headers: {} } : request(value),
          { workspaceId, workflowId, triggerId },
          {},
        );
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toMatchObject({ code });
      expect(service.setEnabled).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, { unexpected: true }])(
    'requires the exact empty command body %#',
    (body) => {
      const { controller, service } = fixture();

      expect(() =>
        controller.enable(
          request(),
          { workspaceId, workflowId, triggerId },
          body,
        ),
      ).toThrow();
      expect(service.setEnabled).not.toHaveBeenCalled();
    },
  );

  it('keeps read and mutation guards in the reviewed order', () => {
    const reflector = new Reflector();
    expect(guards(reflector, 'list')).toEqual([
      SessionAuthenticationGuard,
      ScheduleReadGuard,
    ]);
    for (const method of ['enable', 'disable'] as const)
      expect(guards(reflector, method)).toEqual([
        SessionAuthenticationGuard,
        ScheduleUpdateGuard,
        CsrfProtectionGuard,
      ]);
  });
});

function guards(
  reflector: Reflector,
  method: 'list' | 'enable' | 'disable',
): unknown[] {
  const candidate: unknown = Object.getOwnPropertyDescriptor(
    ScheduleManagementController.prototype,
    method,
  )?.value as unknown;
  if (typeof candidate !== 'function')
    throw new Error(`Schedule controller handler ${method} is missing`);
  return reflector.getAllAndMerge<unknown[]>(GUARDS_METADATA, [
    candidate,
    ScheduleManagementController,
  ]);
}
