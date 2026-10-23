import { TestConnectionUseCase } from '../../../../src/connections/use-cases/test-connection.js';
import {
  authorization,
  connectionTestPersistence,
  sealed,
} from '../../support/use-case-fixture.js';

import { expect, it, vi } from 'vitest';
import { FailureNotificationDestinationsController } from '../../../../src/connections/failure-notifications/controller.js';
import { FailureNotificationDestinationUseCases } from '../../../../src/connections/failure-notifications/destinations.js';

import {
  actorId,
  workspaceId,
  destinationId,
  connectionId,
  workflowId,
  record,
  request,
  command,
  persistence,
} from './fixture.js';

export function registerRejectsInvalidDuplicateIdempotencyHeaderValues(): void {
  it.each([[['duplicate-one', 'duplicate-two']], ['contains,comma'], ['']])(
    'rejects invalid or duplicate idempotency header values %j',
    async (value) => {
      const controller = new FailureNotificationDestinationsController(
        new FailureNotificationDestinationUseCases(
          persistence(),
          'fixture-application-secret',
        ),
        new TestConnectionUseCase(
          connectionTestPersistence(),
          authorization(),
          {
            encryption: {
              seal: vi.fn().mockResolvedValue(sealed),
              open: vi.fn(),
            },
            httpClient: { execute: vi.fn() },
            applicationSecret: 'fixture-application-secret',
          },
        ),
      );

      await expect(
        controller.create(
          request({ 'idempotency-key': value }),
          { workspaceId },
          record.config,
        ),
      ).rejects.toMatchObject({ code: 'request.invalid' });
    },
  );

  it('parses a command, requires idempotency, and forwards canonical metadata', async () => {
    const database = persistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(
        database,
        'fixture-application-secret',
      ),
      new TestConnectionUseCase(connectionTestPersistence(), authorization(), {
        encryption: { seal: vi.fn().mockResolvedValue(sealed), open: vi.fn() },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
      }),
    );

    await expect(
      controller.create(
        request({ 'idempotency-key': 'destination-create-42' }),
        { workspaceId },
        { kind: 'slack', connectionId, channelId: 'C12345' },
      ),
    ).resolves.toMatchObject({
      id: destinationId,
      createdAt: expect.any(String) as unknown,
    });
    expect(database.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        idempotencyKey: 'destination-create-42',
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );

    await expect(
      controller.create(request(), { workspaceId }, record.config),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  });

  it('keeps GET idempotency-free and measures destination-specific commands', async () => {
    const database = persistence();
    const measured: string[] = [];
    const useCases = new FailureNotificationDestinationUseCases(
      database,
      'fixture-application-secret',
      {
        measure: <T>(operation: string, work: () => Promise<T>) => {
          measured.push(operation);
          return work();
        },
      },
    );

    await useCases.list(command);
    await useCases.status({
      ...command,
      idempotencyKey: 'destination-status-42',
      destinationId,
      body: { status: 'disabled' },
    });

    expect(database.list).toHaveBeenCalledWith(
      expect.not.objectContaining({
        idempotencyKey: expect.anything() as unknown,
      }),
    );
    expect(measured).toEqual(['failure_notification_destination.status']);
  });

  it('gets one destination through the controller without command metadata', async () => {
    const database = persistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(
        database,
        'fixture-application-secret',
      ),
      new TestConnectionUseCase(connectionTestPersistence(), authorization(), {
        encryption: { seal: vi.fn().mockResolvedValue(sealed), open: vi.fn() },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
      }),
    );

    await expect(
      controller.get(request(), { workspaceId, destinationId }),
    ).resolves.toMatchObject({
      id: destinationId,
      createdAt: '2026-08-25T10:00:00.000Z',
    });
    expect(database.get).toHaveBeenCalledWith({
      workspaceId,
      destinationId,
      actorId,
      requestId: 'request-42',
      traceId: 'trace-42',
    });
  });

  it('reads the current workflow policy through the safe destination projection', async () => {
    const database = persistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(
        database,
        'fixture-application-secret',
      ),
      new TestConnectionUseCase(connectionTestPersistence(), authorization(), {
        encryption: { seal: vi.fn().mockResolvedValue(sealed), open: vi.fn() },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
      }),
    );

    const current = await controller.getPolicy(request(), {
      workspaceId,
      workflowId,
    });
    expect(current).toEqual({
      destination: {
        id: destinationId,
        workspaceId,
        kind: 'slack',
        status: 'enabled',
        currentVersion: 1,
        config: record.config,
        createdAt: '2026-08-25T10:00:00.000Z',
        updatedAt: '2026-08-25T10:00:00.000Z',
      },
    });
    expect(JSON.stringify(current)).not.toContain('must-not-escape');
    expect(database.getWorkflowPolicy).toHaveBeenCalledWith({
      workspaceId,
      workflowId,
      actorId,
      requestId: 'request-42',
      traceId: 'trace-42',
    });

    vi.mocked(database.getWorkflowPolicy).mockResolvedValueOnce(null);
    await expect(
      controller.getPolicy(request(), { workspaceId, workflowId }),
    ).resolves.toEqual({ destination: null });
    await expect(
      controller.getPolicy(request(), { workspaceId, workflowId: 'nope' }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });
}
