import { Module } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  DoubleSubmitCsrfPolicy,
  OpaqueSessionService,
} from '../../src/identity/index.js';
import { RequestContextStore } from '../../src/platform/http/index.js';
import { ScheduleManagementController } from '../../src/schedules/controllers.js';
import {
  ScheduleReadGuard,
  ScheduleUpdateGuard,
} from '../../src/schedules/guards.js';
import { ScheduleModule } from '../../src/schedules/module.js';
import { ScheduleManagementService } from '../../src/schedules/service.js';
import { SCHEDULE_AUTHORIZATION } from '../../src/schedules/tokens.js';

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}
const sessions = {
  authenticate: () =>
    Promise.resolve({
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      clientMetadata: {},
    }),
};
Module({
  providers: [
    {
      provide: RequestContextStore,
      useValue: { setActor: () => undefined, setWorkspace: () => undefined },
    },
    { provide: OpaqueSessionService, useValue: sessions },
    {
      provide: DoubleSubmitCsrfPolicy,
      useValue: { assertMutationAllowed: () => undefined },
    },
  ],
  exports: [RequestContextStore, OpaqueSessionService, DoubleSubmitCsrfPolicy],
})(FakeIdentityModule);

const scheduleOperations = {
  list: vi.fn(),
  listOccurrences: vi.fn(),
  nextRuns: vi.fn(),
  previewRuns: vi.fn(),
  setEnabled: vi.fn(),
};
const service = scheduleOperations as unknown as ScheduleManagementService;
const authorization = { findAccess: vi.fn().mockResolvedValue(undefined) };

describe('schedule Nest module', () => {
  it('registers one supplied service, authorization source, and guard pair', () => {
    const dynamic = ScheduleModule.register(service, authorization, {
      module: FakeIdentityModule,
    });

    expect(dynamic.controllers).toEqual([ScheduleManagementController]);
    expect(dynamic.imports).toEqual([{ module: FakeIdentityModule }]);
    expect(dynamic.providers).toEqual([
      { provide: ScheduleManagementService, useValue: service },
      { provide: SCHEDULE_AUTHORIZATION, useValue: authorization },
      ScheduleReadGuard,
      ScheduleUpdateGuard,
    ]);
  });

  it('resolves the controller and both guards through Nest injection', async () => {
    const testing = await Test.createTestingModule({
      imports: [
        ScheduleModule.register(service, authorization, {
          module: FakeIdentityModule,
        }),
      ],
    }).compile();
    try {
      expect(testing.get(ScheduleManagementController)).toBeInstanceOf(
        ScheduleManagementController,
      );
      expect(testing.get(ScheduleReadGuard)).toBeInstanceOf(ScheduleReadGuard);
      expect(testing.get(ScheduleUpdateGuard)).toBeInstanceOf(
        ScheduleUpdateGuard,
      );
    } finally {
      await testing.close();
    }
  });

  it('does not invoke a mutation after workspace authorization denies it', async () => {
    authorization.findAccess.mockClear();
    scheduleOperations.setEnabled.mockClear();
    const testing = await Test.createTestingModule({
      imports: [
        ScheduleModule.register(service, authorization, {
          module: FakeIdentityModule,
        }),
      ],
    }).compile();
    const adapter = new FastifyAdapter();
    const application = testing.createNestApplication(adapter);
    try {
      await application.init();
      const server = adapter.getInstance();
      const response = await server.inject({
        method: 'POST',
        url: '/v1/workspaces/cccccccc-cccc-4ccc-8ccc-cccccccccccc/workflows/dddddddd-dddd-4ddd-8ddd-dddddddddddd/triggers/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/schedule/enable',
        headers: {
          cookie: 'pertexo_session=session-token',
          'content-type': 'application/json',
          'idempotency-key': 'schedule-denied',
        },
        payload: {},
      });

      expect(response.statusCode).not.toBe(200);
      expect(authorization.findAccess).toHaveBeenCalledOnce();
      expect(scheduleOperations.setEnabled).not.toHaveBeenCalled();
    } finally {
      await application.close();
    }
  });
});
