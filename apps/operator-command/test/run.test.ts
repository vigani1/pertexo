import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OperatorCommandResources } from '../src/run.js';
import { runOperatorCommand } from '../src/run.js';

const operationNames = [
  'getCommand',
  'redispatchFailedOutbox',
  'reconcileAttempt',
  'resumeDueWork',
  'cancelRun',
  'recordUnknownOutcomeEvidence',
  'retryTriggerReconciliation',
  'replayRun',
  'requestMaintenanceRerun',
] as const;

const commandBase = () =>
  ({
    actorRef: 'ci-test-operator',
    commandId: randomUUID(),
    reason: 'operator test',
    workspaceId: randomUUID(),
  }) as const;

function createResources(
  command: OperatorCommandResources['command'],
  options: Readonly<{ result?: unknown; signal?: AbortSignal }> = {},
) {
  const result = Object.hasOwn(options, 'result')
    ? options.result
    : {
        commandId: command.commandId,
        outcome: 'completed',
        replayed: false,
        status: 'completed',
      };
  const database = {
    cancelRun: vi.fn().mockResolvedValue(result),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getCommand: vi.fn().mockResolvedValue(result),
    reconcileAttempt: vi.fn().mockResolvedValue(result),
    recordUnknownOutcomeEvidence: vi.fn().mockResolvedValue(result),
    redispatchFailedOutbox: vi.fn().mockResolvedValue(result),
    resumeDueWork: vi.fn().mockResolvedValue(result),
    retryTriggerReconciliation: vi.fn().mockResolvedValue(result),
    replayRun: vi.fn().mockResolvedValue(result),
    requestMaintenanceRerun: vi.fn().mockResolvedValue(result),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const telemetry = {
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  const resources = {
    cleanupTimeoutMs: 1_000,
    command,
    database,
    logger,
    signal: options.signal ?? new AbortController().signal,
    telemetry,
  } as unknown as OperatorCommandResources;
  return { database, logger, resources, result, telemetry };
}

const cases: readonly (readonly [
  string,
  OperatorCommandResources['command'],
  (typeof operationNames)[number],
])[] = [
  ['status', { ...commandBase(), type: 'operator.status' }, 'getCommand'],
  [
    'outbox redispatch',
    {
      ...commandBase(),
      dryRun: false,
      outboxEventId: randomUUID(),
      type: 'outbox.redispatch',
    },
    'redispatchFailedOutbox',
  ],
  [
    'attempt reconciliation',
    {
      ...commandBase(),
      action: 'reclaim',
      attemptId: randomUUID(),
      dryRun: true,
      expectedFenceToken: 3,
      type: 'attempt.reconcile',
    },
    'reconcileAttempt',
  ],
  [
    'due work resume',
    {
      ...commandBase(),
      dryRun: false,
      runId: randomUUID(),
      type: 'due-work.resume',
    },
    'resumeDueWork',
  ],
  [
    'run cancellation',
    { ...commandBase(), dryRun: true, runId: randomUUID(), type: 'run.cancel' },
    'cancelRun',
  ],
  [
    'unknown outcome evidence',
    {
      ...commandBase(),
      attemptId: randomUUID(),
      evidenceKind: 'provider.receipt',
      evidenceRef: { receipt: 'receipt-1' },
      type: 'unknown-outcome.record-evidence',
    },
    'recordUnknownOutcomeEvidence',
  ],
  [
    'trigger reconciliation',
    {
      ...commandBase(),
      dryRun: false,
      type: 'trigger.reconcile',
      workflowId: randomUUID(),
    },
    'retryTriggerReconciliation',
  ],
  [
    'run replay',
    {
      ...commandBase(),
      dryRun: true,
      runInput: { safe: true },
      sourceRunId: randomUUID(),
      type: 'run.replay',
      workflowVersionId: randomUUID(),
    },
    'replayRun',
  ],
  [
    'retention rerun',
    {
      ...commandBase(),
      dryRun: false,
      targetId: randomUUID(),
      targetType: 'retention_batch',
      type: 'retention.rerun',
    },
    'requestMaintenanceRerun',
  ],
  [
    'purge rerun',
    {
      ...commandBase(),
      dryRun: true,
      targetId: randomUUID(),
      targetType: 'workspace_purge_job',
      type: 'purge.rerun',
    },
    'requestMaintenanceRerun',
  ],
];

describe('operator command runner', () => {
  afterEach(() => vi.useRealTimers());

  it.each(cases)(
    'routes %s with audit fields and closes resources',
    async (_label, command, selectedOperation) => {
      const fixture = createResources(command);
      await expect(runOperatorCommand(fixture.resources)).resolves.toBe(
        fixture.result,
      );
      expect(fixture.database.checkReadiness).toHaveBeenCalledOnce();
      const fields = Object.fromEntries(
        Object.entries(command).filter(([key]) => key !== 'type'),
      );
      expect(fixture.database[selectedOperation]).toHaveBeenCalledWith({
        ...(command.type === 'operator.status' ||
        command.type === 'outbox.redispatch'
          ? fields
          : command),
        signal: fixture.resources.signal,
      });
      for (const operation of operationNames)
        expect(fixture.database[operation]).toHaveBeenCalledTimes(
          operation === selectedOperation ? 1 : 0,
        );
      expect(fixture.database.close).toHaveBeenCalledOnce();
      expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
      expect(fixture.logger.info).toHaveBeenCalledWith(
        'operator_command.completed',
        expect.objectContaining({
          commandType: command.type,
          outcome: 'completed',
        }),
      );
    },
  );

  it('returns a missing status as null and logs not_found', async () => {
    const fixture = createResources(
      { ...commandBase(), type: 'operator.status' },
      { result: null },
    );
    await expect(runOperatorCommand(fixture.resources)).resolves.toBeNull();
    expect(fixture.logger.info).toHaveBeenCalledWith(
      'operator_command.completed',
      expect.objectContaining({ outcome: 'not_found' }),
    );
  });

  it('does not check readiness or dispatch when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));
    const fixture = createResources(
      { ...commandBase(), type: 'operator.status' },
      { signal: controller.signal },
    );
    await expect(runOperatorCommand(fixture.resources)).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(fixture.telemetry.start).toHaveBeenCalledOnce();
    expect(fixture.database.checkReadiness).not.toHaveBeenCalled();
    expect(fixture.database.getCommand).not.toHaveBeenCalled();
    expect(fixture.database.close).toHaveBeenCalledOnce();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('stops at readiness failure and still cleans up', async () => {
    const fixture = createResources({
      ...commandBase(),
      type: 'operator.status',
    });
    fixture.database.checkReadiness.mockRejectedValueOnce(
      new Error('not ready'),
    );
    await expect(runOperatorCommand(fixture.resources)).rejects.toThrow(
      'Operator command did not complete cleanly',
    );
    expect(fixture.database.getCommand).not.toHaveBeenCalled();
    expect(fixture.database.close).toHaveBeenCalledOnce();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('preserves an operation failure while attempting both cleanups', async () => {
    const fixture = createResources({
      ...commandBase(),
      dryRun: false,
      runId: randomUUID(),
      type: 'run.cancel',
    });
    const operationError = new Error('cancel failed');
    fixture.database.cancelRun.mockRejectedValueOnce(operationError);
    await expect(
      runOperatorCommand(fixture.resources).catch((error: unknown) => error),
    ).resolves.toMatchObject({ errors: [operationError] });
    expect(fixture.database.close).toHaveBeenCalledOnce();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('preserves an undefined operation rejection while attempting both cleanups', async () => {
    const fixture = createResources({
      ...commandBase(),
      dryRun: false,
      runId: randomUUID(),
      type: 'run.cancel',
    });
    fixture.database.cancelRun.mockRejectedValueOnce(undefined);
    await expect(
      runOperatorCommand(fixture.resources).catch((error: unknown) => error),
    ).resolves.toMatchObject({ errors: [undefined] });
    expect(fixture.database.close).toHaveBeenCalledOnce();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('bounds a stuck cleanup and continues to the next cleanup', async () => {
    vi.useFakeTimers();
    const fixture = createResources({
      ...commandBase(),
      type: 'operator.status',
    });
    Object.assign(fixture.resources, { cleanupTimeoutMs: 25 });
    fixture.database.close.mockReturnValueOnce(new Promise(() => undefined));
    const result = runOperatorCommand(fixture.resources).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'Database cleanup timed out' }),
      ],
    });
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('reports failures from both cleanup owners', async () => {
    const fixture = createResources({
      ...commandBase(),
      type: 'operator.status',
    });
    const databaseError = new Error('database close failed');
    const telemetryError = new Error('telemetry shutdown failed');
    fixture.database.close.mockRejectedValueOnce(databaseError);
    fixture.telemetry.shutdown.mockRejectedValueOnce(telemetryError);
    await expect(
      runOperatorCommand(fixture.resources).catch((error: unknown) => error),
    ).resolves.toMatchObject({ errors: [databaseError, telemetryError] });
  });
});
