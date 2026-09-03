import {
  FailureNotificationDestinationError,
  type FailureNotificationDestinationDatabase,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  FailureNotificationDestinationsController,
  FailureNotificationDestinationUseCases,
} from '../../src/connections/failure-notification-destinations.js';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- assertions target injected Vitest spies */

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const destinationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const connectionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workflowId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const record = {
  id: destinationId,
  workspaceId,
  kind: 'slack' as const,
  status: 'enabled' as const,
  currentVersion: 1,
  config: { kind: 'slack' as const, connectionId, channelId: 'C12345' },
  createdAt: new Date('2026-08-25T10:00:00.000Z'),
  updatedAt: new Date('2026-08-25T10:00:00.000Z'),
};

function request(headers: Record<string, string> = {}) {
  return {
    requestId: 'request-42',
    traceId: 'trace-42',
    headers,
    identitySession: {
      userId: actorId,
      sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expiresAt: new Date('2026-08-25T20:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

function persistence(): FailureNotificationDestinationDatabase {
  return {
    create: vi.fn().mockResolvedValue(record),
    get: vi.fn().mockResolvedValue(record),
    list: vi.fn().mockResolvedValue([record]),
    appendVersion: vi.fn().mockResolvedValue(record),
    setStatus: vi.fn().mockResolvedValue(record),
    setWorkflowPolicy: vi.fn(),
    clearWorkflowPolicy: vi.fn(),
    close: vi.fn(),
  };
}

describe('failure notification destination API seams', () => {
  it('parses a command, requires idempotency, and forwards canonical metadata', async () => {
    const database = persistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(database),
    );

    await expect(
      controller.create(
        request({ 'idempotency-key': 'destination-create-42' }),
        { workspaceId },
        { kind: 'slack', connectionId, channelId: 'C12345' },
      ),
    ).resolves.toMatchObject({
      id: destinationId,
      createdAt: expect.any(String),
    });
    expect(database.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        idempotencyKey: 'destination-create-42',
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );

    await expect(
      controller.create(request(), { workspaceId }, record.config),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('keeps GET idempotency-free and measures destination-specific commands', async () => {
    const database = persistence();
    const measured: string[] = [];
    const useCases = new FailureNotificationDestinationUseCases(database, {
      measure: <T>(operation: string, work: () => Promise<T>) => {
        measured.push(operation);
        return work();
      },
    });

    await useCases.list({ request: request(), workspaceId });
    await useCases.status({
      request: request({ 'idempotency-key': 'destination-status-42' }),
      workspaceId,
      destinationId,
      body: { status: 'disabled' },
    });

    expect(database.list).toHaveBeenCalledWith(
      expect.not.objectContaining({ idempotencyKey: expect.anything() }),
    );
    expect(measured).toEqual(['failure_notification_destination.status']);
  });

  it('gets one destination through the controller without command metadata', async () => {
    const database = persistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(database),
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

  it('appends a version and maps optimistic and idempotency conflicts', async () => {
    const database = persistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(database),
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
      new FailureNotificationDestinationUseCases(database),
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
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
    expect(database.clearWorkflowPolicy).toHaveBeenCalledTimes(2);
    expect(vi.mocked(database.clearWorkflowPolicy).mock.calls[0]?.[0]).toEqual(
      vi.mocked(database.clearWorkflowPolicy).mock.calls[1]?.[0],
    );
  });

  it('maps hidden destination reads and writes to not found', async () => {
    const database = persistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(database),
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
});
