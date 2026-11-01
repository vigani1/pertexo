import { TestConnectionUseCase } from '../../../../src/connections/use-cases/test-connection.js';
import {
  authorization,
  connectionTestPersistence,
  sealed,
} from '../../support/use-case-fixture.js';
import { FailureNotificationDestinationError } from '@pertexo/core/testing';
import { expect, it, vi } from 'vitest';
import { FailureNotificationDestinationsController } from '../../../../src/connections/failure-notifications/controller.js';
import { FailureNotificationDestinationUseCases } from '../../../../src/connections/failure-notifications/destinations.js';

import {
  workspaceId,
  destinationId,
  workflowId,
  record,
  request,
  persistence,
} from './fixture.js';

export function registerAppendsVersionPropagatesOptimisticIdempotencyConflicts(): void {
  it('appends a version and propagates optimistic and idempotency conflicts', async () => {
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
    const body = {
      expectedVersion: 1,
      config: { ...record.config, channelId: 'C67890' },
    } as const;

    await expect(
      controller.append(
        request({ 'idempotency-key': 'destination-append-42' }),
        { workspaceId, destinationId },
        body,
      ),
    ).resolves.toMatchObject({ id: destinationId });
    expect(database.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        destinationId,
        expectedVersion: 1,
        config: body.config,
        idempotencyKey: 'destination-append-42',
      }),
    );

    vi.mocked(database.appendVersion).mockRejectedValueOnce(
      new FailureNotificationDestinationError('conflict'),
    );
    await expect(
      controller.append(
        request({ 'idempotency-key': 'destination-append-43' }),
        { workspaceId, destinationId },
        body,
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      name: 'FailureNotificationDestinationError',
    });

    vi.mocked(database.appendVersion).mockRejectedValueOnce(
      new FailureNotificationDestinationError('idempotency_conflict'),
    );
    await expect(
      controller.append(
        request({ 'idempotency-key': 'destination-append-44' }),
        { workspaceId, destinationId },
        body,
      ),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      name: 'FailureNotificationDestinationError',
    });
  });

  it('sets and clears workflow policy with exact idempotent replay metadata', async () => {
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
    const setRequest = request({ 'idempotency-key': 'policy-set-42' });
    const clearRequest = request({ 'idempotency-key': 'policy-clear-42' });

    await controller.setPolicy(
      setRequest,
      { workspaceId, workflowId },
      { destinationId },
    );
    await controller.setPolicy(
      setRequest,
      { workspaceId, workflowId },
      { destinationId },
    );
    await controller.clearPolicy(clearRequest, { workspaceId, workflowId });
    await controller.clearPolicy(clearRequest, { workspaceId, workflowId });

    expect(database.setWorkflowPolicy).toHaveBeenCalledTimes(2);
    expect(vi.mocked(database.setWorkflowPolicy).mock.calls[0]?.[0]).toEqual(
      vi.mocked(database.setWorkflowPolicy).mock.calls[1]?.[0],
    );
    expect(database.setWorkflowPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        workflowId,
        destinationId,
        idempotencyKey: 'policy-set-42',
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
      }),
    );
    expect(database.clearWorkflowPolicy).toHaveBeenCalledTimes(2);
    expect(vi.mocked(database.clearWorkflowPolicy).mock.calls[0]?.[0]).toEqual(
      vi.mocked(database.clearWorkflowPolicy).mock.calls[1]?.[0],
    );
  });

  it('propagates hidden destination read and write failures', async () => {
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
    vi.mocked(database.get).mockRejectedValueOnce(
      new FailureNotificationDestinationError('not_found'),
    );
    await expect(
      controller.get(request(), { workspaceId, destinationId }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'FailureNotificationDestinationError',
    });

    vi.mocked(database.appendVersion).mockRejectedValueOnce(
      new FailureNotificationDestinationError('not_found'),
    );
    await expect(
      controller.append(
        request({ 'idempotency-key': 'destination-hidden-42' }),
        { workspaceId, destinationId },
        {
          expectedVersion: 1,
          config: { ...record.config, channelId: 'C67890' },
        },
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'FailureNotificationDestinationError',
    });
  });
}
