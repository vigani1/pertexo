import type { FailureNotificationDestinationDatabase } from '@pertexo/database';
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
    ).rejects.toMatchObject({ code: 'request.invalid' });
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

    await useCases.list(request(), workspaceId);
    await useCases.status(
      request({ 'idempotency-key': 'destination-status-42' }),
      workspaceId,
      destinationId,
      { status: 'disabled' },
    );

    expect(database.list).toHaveBeenCalledWith(
      expect.not.objectContaining({ idempotencyKey: expect.anything() }),
    );
    expect(measured).toEqual(['failure_notification_destination.status']);
  });
});
