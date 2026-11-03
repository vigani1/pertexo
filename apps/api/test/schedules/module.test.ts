import { FakeIdentityModule } from '../support/identity-module.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleModule } from '../../src/schedules/module.js';
import type { ScheduleManagementService } from '../../src/schedules/service.js';

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
