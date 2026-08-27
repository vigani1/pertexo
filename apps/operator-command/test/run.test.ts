import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { runOperatorCommand } from '../src/run.js';

describe('operator command runner', () => {
  it('checks readiness, executes once, and closes all resources', async () => {
    const result = {
      commandId: randomUUID(),
      outcome: 'redispatched',
      replayed: false,
      status: 'completed',
    } as const;
    const database = {
      cancelRun: vi.fn(),
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getCommand: vi.fn(),
      reconcileAttempt: vi.fn(),
      recordUnknownOutcomeEvidence: vi.fn(),
      redispatchFailedOutbox: vi.fn().mockResolvedValue(result),
      resumeDueWork: vi.fn(),
      retryTriggerReconciliation: vi.fn(),
      replayRun: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const telemetry = {
      start: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      runOperatorCommand({
        cleanupTimeoutMs: 1_000,
        command: {
          actorRef: 'ci-test-operator',
          commandId: result.commandId,
          dryRun: false,
          outboxEventId: randomUUID(),
          reason: 'retry after queue recovery',
          type: 'outbox.redispatch',
          workspaceId: randomUUID(),
        },
        database,
        logger: logger as never,
        signal: new AbortController().signal,
        telemetry: telemetry as never,
      }),
    ).resolves.toEqual(result);
    expect(database.checkReadiness).toHaveBeenCalledOnce();
    expect(database.redispatchFailedOutbox).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      'operator_command.completed',
      expect.objectContaining({
        commandType: 'outbox.redispatch',
        outcome: 'redispatched',
      }),
    );
  });
});
