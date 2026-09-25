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
    listOccurrences: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    nextRuns: vi.fn().mockResolvedValue({ observedAt: '', items: [] }),
    previewRuns: vi.fn().mockResolvedValue({ observedAt: '', items: [] }),
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

  it('forwards occurrence paging only when the client supplied it', async () => {
    const { controller, service } = fixture();
    const route = { workspaceId, workflowId, triggerId };

    await controller.occurrences(request(), route, undefined);
    await controller.occurrences(request(), route, {
      limit: '5',
      after: 'opaque-cursor',
    });

    expect(service.listOccurrences.mock.calls).toEqual([
      [{ ...route, actorId }],
      [{ ...route, actorId, limit: 5, after: 'opaque-cursor' }],
    ]);
  });

  it.each([{ limit: '0' }, { limit: '101' }, { after: '' }, { sort: 'asc' }])(
    'rejects an invalid occurrence query %j before reading',
    (query) => {
      const { controller, service } = fixture();
      expect(() =>
        controller.occurrences(
          request(),
          { workspaceId, workflowId, triggerId },
          query,
        ),
      ).toThrow();
      expect(service.listOccurrences).not.toHaveBeenCalled();
    },
  );

  it('defaults next runs to three and bounds the count', async () => {
    const { controller, service } = fixture();
    const route = { workspaceId, workflowId, triggerId };

    await controller.nextRuns(request(), route, {});
    await controller.nextRuns(request(), route, { count: '10' });

    expect(service.nextRuns.mock.calls).toEqual([
      [{ ...route, actorId, count: 3 }],
      [{ ...route, actorId, count: 10 }],
    ]);
    for (const query of [{ count: '0' }, { count: '11' }, { at: 'now' }])
      expect(() => controller.nextRuns(request(), route, query)).toThrow();
    expect(service.nextRuns).toHaveBeenCalledTimes(2);
  });

  it('previews only a strictly valid Schedule step setup', async () => {
    const { controller, service } = fixture();
    const config = {
      kind: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
      misfirePolicy: 'skip',
    };

    await controller.preview(
      request(),
      { workspaceId, workflowId },
      { config },
    );
    await controller.preview(
      request(),
      { workspaceId, workflowId },
      { config, count: 1 },
    );

    expect(service.previewRuns.mock.calls).toEqual([
      [{ workspaceId, workflowId, actorId, config, count: 3 }],
      [{ workspaceId, workflowId, actorId, config, count: 1 }],
    ]);
    for (const body of [
      undefined,
      { config: { ...config, anchorAt: 'now' } },
      { config: { kind: 'interval', intervalMinutes: 0 } },
      { config, count: 11 },
      { config, triggerId },
    ])
      expect(() =>
        controller.preview(request(), { workspaceId, workflowId }, body),
      ).toThrow();
    expect(() =>
      controller.preview(
        request(),
        { workspaceId, workflowId, triggerId },
        { config },
      ),
    ).toThrow();
    expect(service.previewRuns).toHaveBeenCalledTimes(2);
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
    for (const method of ['list', 'occurrences', 'nextRuns'] as const)
      expect(guards(reflector, method)).toEqual([
        SessionAuthenticationGuard,
        ScheduleReadGuard,
      ]);
    expect(guards(reflector, 'preview')).toEqual([
      SessionAuthenticationGuard,
      ScheduleReadGuard,
      CsrfProtectionGuard,
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
  method:
    'list' | 'occurrences' | 'nextRuns' | 'preview' | 'enable' | 'disable',
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
