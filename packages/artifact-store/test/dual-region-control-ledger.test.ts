import { describe, expect, it, vi } from 'vitest';

import {
  ControlLedgerClosedError,
  ControlLedgerConflictError,
  ControlLedgerIntegrityError,
} from '../src/control-ledger.js';
import type {
  AppendControlLedgerRecord,
  ControlLedger,
  ControlLedgerReadiness,
  ControlLedgerReadRequest,
  ControlLedgerReconciliation,
  ControlLedgerRecord,
  ReconcileControlLedgerRequest,
} from '../src/control-ledger.js';
import type { ObjectStoreObserver } from '../src/object-store-telemetry.js';
import {
  ControlLedgerPartialReplicationError,
  createDualRegionControlLedger,
} from '../src/dual-region-control-ledger.js';

const WORKSPACE_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01';
const COMMAND_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02';
const SUBJECT_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c03';
const ZERO_HASH = '0'.repeat(64);

function record(
  overrides: Partial<ControlLedgerRecord> = {},
): ControlLedgerRecord {
  return {
    actorRef: 'operator:test',
    commandId: COMMAND_ID,
    commandType: 'deletion_requested',
    occurredAt: '2026-08-26T12:34:56.000Z',
    previousHash: ZERO_HASH,
    reason: 'workspace owner request',
    recordHash: '1'.repeat(64),
    schemaVersion: 1,
    sequence: 1,
    subjectId: SUBJECT_ID,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  } as ControlLedgerRecord;
}

function appendRequest(
  overrides: Partial<AppendControlLedgerRecord> = {},
): AppendControlLedgerRecord {
  return {
    actorRef: 'operator:test',
    commandId: COMMAND_ID,
    commandType: 'deletion_requested',
    occurredAt: '2026-08-26T12:34:56.000Z',
    previousHash: ZERO_HASH,
    reason: 'workspace owner request',
    sequence: 1,
    subjectId: SUBJECT_ID,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  } as AppendControlLedgerRecord;
}

function reconciliation(
  overrides: Partial<ControlLedgerReconciliation> = {},
): ControlLedgerReconciliation {
  return {
    hasMore: false,
    pageEndHash: '1'.repeat(64),
    pageEndSequence: 1,
    reachedHighWater: true,
    records: [record()],
    ...overrides,
  };
}

class FakeLedger implements ControlLedger {
  public closeCalls = 0;
  public readinessCalls = 0;
  public readonly appendRequests: AppendControlLedgerRecord[] = [];
  public readonly readRequests: ControlLedgerReadRequest[] = [];
  public readonly reconcileRequests: ReconcileControlLedgerRequest[] = [];
  public storedRecord: ControlLedgerRecord | null = null;
  public appendImplementation: (
    request: AppendControlLedgerRecord,
  ) => Promise<ControlLedgerRecord> = () => Promise.resolve(record());
  public readinessImplementation: (
    signal?: AbortSignal,
  ) => Promise<ControlLedgerReadiness>;
  public readImplementation: (
    request: ControlLedgerReadRequest,
  ) => Promise<ControlLedgerRecord | null> = () =>
    Promise.resolve(this.storedRecord);
  public reconcileImplementation: (
    request: ReconcileControlLedgerRequest,
  ) => Promise<ControlLedgerReconciliation> = () =>
    Promise.resolve(reconciliation());

  public constructor(bucket: string, region: string) {
    this.readinessImplementation = () =>
      Promise.resolve({
        bucket,
        minRetentionDays: 30,
        prefix: 'control-ledger/workspaces/',
        region,
      });
  }

  public async append(
    request: AppendControlLedgerRecord,
  ): Promise<ControlLedgerRecord> {
    this.appendRequests.push(request);
    const appended = await this.appendImplementation(request);
    this.storedRecord = appended;
    return appended;
  }

  public checkReadiness(signal?: AbortSignal): Promise<ControlLedgerReadiness> {
    this.readinessCalls += 1;
    return this.readinessImplementation(signal);
  }

  public close(): void {
    this.closeCalls += 1;
  }

  public async read(
    request: ControlLedgerReadRequest,
  ): Promise<ControlLedgerRecord | null> {
    this.readRequests.push(request);
    return this.readImplementation(request);
  }

  public async reconcile(
    request: ReconcileControlLedgerRequest,
  ): Promise<ControlLedgerReconciliation> {
    this.reconcileRequests.push(request);
    return this.reconcileImplementation(request);
  }
}

function fixture(observer?: ObjectStoreObserver) {
  const primary = new FakeLedger('ledger-primary', 'eu-central-1');
  const recovery = new FakeLedger('ledger-recovery', 'eu-west-1');
  return {
    ledger: createDualRegionControlLedger(primary, recovery, {
      ledgerOwnership: 'borrowed',
      ...(observer === undefined ? {} : { observer }),
    }),
    primary,
    recovery,
  };
}

function rejectWhenAborted<TResult>(
  signal: AbortSignal | undefined,
  settle: () => void,
  message: string,
): Promise<TResult> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => {
        settle();
        reject(new Error(message));
      },
      { once: true },
    );
  });
}

describe('dual-region control ledger', () => {
  it('checks both readiness controls concurrently and proves isolation', async () => {
    const { ledger, primary, recovery } = fixture();
    let primaryStarted = false;
    let recoveryStarted = false;
    primary.readinessImplementation = async () => {
      primaryStarted = true;
      await vi.waitFor(() => {
        expect(recoveryStarted).toBe(true);
      });
      return {
        bucket: 'ledger-primary',
        minRetentionDays: 30,
        prefix: 'control-ledger/workspaces/',
        region: 'eu-central-1',
      };
    };
    recovery.readinessImplementation = async () => {
      recoveryStarted = true;
      await vi.waitFor(() => {
        expect(primaryStarted).toBe(true);
      });
      return {
        bucket: 'ledger-recovery',
        minRetentionDays: 31,
        prefix: 'control-ledger/workspaces/',
        region: 'eu-west-1',
      };
    };

    await expect(ledger.checkReadiness()).resolves.toMatchObject({
      primary: { bucket: 'ledger-primary', region: 'eu-central-1' },
      recovery: { bucket: 'ledger-recovery', region: 'eu-west-1' },
    });

    recovery.readinessImplementation = () =>
      Promise.resolve({
        bucket: 'ledger-primary',
        minRetentionDays: 30,
        prefix: 'control-ledger/workspaces/',
        region: 'eu-west-1',
      });
    await expect(ledger.checkReadiness()).rejects.toThrow('must be distinct');
  });

  it.each([
    ['primary', true, false],
    ['recovery', false, true],
    ['both', true, true],
  ] as const)(
    'classifies %s readiness unavailability at the readiness stage',
    async (role, failPrimary, failRecovery) => {
      const observations: unknown[] = [];
      const { ledger, primary, recovery } = fixture({
        observeRequest: () => undefined,
        observeSafetyViolation: (observation) => observations.push(observation),
      });
      if (failPrimary) {
        primary.readinessImplementation = () =>
          Promise.reject(new Error('primary readiness unavailable'));
      }
      if (failRecovery) {
        recovery.readinessImplementation = () =>
          Promise.reject(new Error('recovery readiness unavailable'));
      }

      await expect(ledger.checkReadiness()).rejects.toMatchObject({
        name: 'ControlLedgerReadinessError',
        message: 'Dual-region control ledger readiness could not be verified',
      });
      expect(observations).toEqual([
        {
          check: 'control_ledger_integrity',
          failedRegionRole: role,
          operation: 'readiness',
          outcome: 'unavailable',
          regionRole: 'primary',
          surface: 'control_ledger',
        },
      ]);
    },
  );

  it('preserves cancellation after both readiness checks settle', async () => {
    const { ledger, primary, recovery } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancelled during readiness');
    let primarySettled = false;
    let recoverySettled = false;
    primary.readinessImplementation = (signal) =>
      rejectWhenAborted<ControlLedgerReadiness>(
        signal,
        () => {
          primarySettled = true;
        },
        'regional readiness aborted',
      );
    recovery.readinessImplementation = (signal) =>
      rejectWhenAborted<ControlLedgerReadiness>(
        signal,
        () => {
          recoverySettled = true;
        },
        'regional readiness aborted',
      );

    const pending = ledger.checkReadiness(controller.signal);
    await vi.waitFor(() => {
      expect(primary.readinessCalls).toBe(1);
      expect(recovery.readinessCalls).toBe(1);
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(primarySettled).toBe(true);
    expect(recoverySettled).toBe(true);
  });

  it('rejects shared config access key IDs before creating clients', () => {
    const config = {
      accessKeyId: 'shared-access',
      bucket: 'ledger-primary',
      endpoint: 'https://s3.eu-central-1.amazonaws.com',
      forcePathStyle: false,
      minRetentionDays: 30,
      region: 'eu-central-1',
      requestTimeoutMs: 5_000,
      secretAccessKey: 'primary-secret',
    };
    expect(() =>
      createDualRegionControlLedger(config, {
        ...config,
        bucket: 'ledger-recovery',
        region: 'eu-west-1',
        secretAccessKey: 'recovery-secret',
      }),
    ).toThrow('access key IDs must be distinct');
  });

  it.each(['append', 'read', 'reconcile'] as const)(
    'proves injected ledger isolation before %s',
    async (operation) => {
      const { ledger, primary, recovery } = fixture();
      recovery.readinessImplementation = () =>
        Promise.resolve({
          bucket: 'ledger-recovery',
          minRetentionDays: 30,
          prefix: 'control-ledger/workspaces/',
          region: 'eu-central-1',
        });

      const pending =
        operation === 'append'
          ? ledger.append(appendRequest())
          : operation === 'read'
            ? ledger.read({ sequence: 1, workspaceId: WORKSPACE_ID })
            : ledger.reconcile({
                maxRecords: 10,
                projectedHash: ZERO_HASH,
                projectedSequence: 0,
                workspaceId: WORKSPACE_ID,
              });
      await expect(pending).rejects.toThrow('must be distinct');
      expect(primary.readinessCalls).toBe(1);
      expect(recovery.readinessCalls).toBe(1);
      expect(primary.appendRequests).toHaveLength(0);
      expect(recovery.appendRequests).toHaveLength(0);
      expect(primary.readRequests).toHaveLength(0);
      expect(recovery.readRequests).toHaveLength(0);
      expect(primary.reconcileRequests).toHaveLength(0);
      expect(recovery.reconcileRequests).toHaveLength(0);
    },
  );

  it('sends the exact same append concurrently and requires exact results', async () => {
    const { ledger, primary, recovery } = fixture();
    const request = appendRequest();
    await expect(ledger.append(request)).resolves.toEqual(record());
    expect(primary.appendRequests).toEqual([request]);
    expect(recovery.appendRequests).toEqual([request]);
    expect(primary.appendRequests[0]).toBe(recovery.appendRequests[0]);
  });

  it('reports partial replication and recovers only through exact retry', async () => {
    const { ledger, primary, recovery } = fixture();
    const request = appendRequest();
    let recoveryAttempts = 0;
    recovery.appendImplementation = () => {
      recoveryAttempts += 1;
      return recoveryAttempts === 1
        ? Promise.reject(new Error('recovery unavailable'))
        : Promise.resolve(record());
    };

    await expect(ledger.append(request)).rejects.toBeInstanceOf(
      ControlLedgerPartialReplicationError,
    );
    await expect(ledger.append(request)).resolves.toEqual(record());
    expect(primary.appendRequests).toEqual([request]);
    expect(recovery.appendRequests).toEqual([request, request]);
  });

  it.each(['primary', 'recovery'] as const)(
    'repairs only the missing region when %s alone has the exact record',
    async (presentRole) => {
      const { ledger, primary, recovery } = fixture();
      if (presentRole === 'primary') primary.storedRecord = record();
      else recovery.storedRecord = record();

      await expect(ledger.append(appendRequest())).resolves.toEqual(record());
      expect(primary.appendRequests).toHaveLength(
        presentRole === 'primary' ? 0 : 1,
      );
      expect(recovery.appendRequests).toHaveLength(
        presentRole === 'recovery' ? 0 : 1,
      );
    },
  );

  it.each([
    ['primary', true, false, ControlLedgerPartialReplicationError],
    ['recovery', false, true, ControlLedgerPartialReplicationError],
    ['both', true, true, ControlLedgerIntegrityError],
  ] as const)(
    'classifies %s append availability failures without claiming success',
    async (_role, failPrimary, failRecovery, expectedError) => {
      const { ledger, primary, recovery } = fixture();
      if (failPrimary) {
        primary.appendImplementation = () =>
          Promise.reject(new Error('primary unavailable'));
      }
      if (failRecovery) {
        recovery.appendImplementation = () =>
          Promise.reject(new Error('recovery unavailable'));
      }

      await expect(ledger.append(appendRequest())).rejects.toBeInstanceOf(
        expectedError,
      );
      expect(primary.appendRequests).toHaveLength(1);
      expect(recovery.appendRequests).toHaveLength(1);
    },
  );

  it.each([
    ['primary', true, false],
    ['recovery', false, true],
    ['both', true, true],
  ] as const)(
    'fails append before writing when %s pre-read state is unavailable',
    async (role, failPrimary, failRecovery) => {
      const observations: unknown[] = [];
      const { ledger, primary, recovery } = fixture({
        observeRequest: () => undefined,
        observeSafetyViolation: (observation) => observations.push(observation),
      });
      if (failPrimary) {
        primary.readImplementation = () =>
          Promise.reject(new Error('primary read unavailable'));
      }
      if (failRecovery) {
        recovery.readImplementation = () =>
          Promise.reject(new Error('recovery read unavailable'));
      }

      await expect(ledger.append(appendRequest())).rejects.toMatchObject({
        name: 'ControlLedgerIntegrityError',
        message:
          'Dual-region control ledger append pre-read could not be proven',
      });
      expect(primary.readRequests).toHaveLength(1);
      expect(recovery.readRequests).toHaveLength(1);
      expect(primary.appendRequests).toHaveLength(0);
      expect(recovery.appendRequests).toHaveLength(0);
      expect(observations).toEqual([
        {
          check: 'control_ledger_integrity',
          failedRegionRole: role,
          operation: 'append',
          outcome: 'unavailable',
          regionRole: 'primary',
          surface: 'control_ledger',
        },
      ]);
    },
  );

  it('replays equal records already present in both regions without writing', async () => {
    const { ledger, primary, recovery } = fixture();
    primary.storedRecord = record();
    recovery.storedRecord = record();

    await expect(ledger.append(appendRequest())).resolves.toEqual(record());
    expect(primary.appendRequests).toHaveLength(0);
    expect(recovery.appendRequests).toHaveLength(0);
  });

  it('rejects divergent records already present in both regions without writing', async () => {
    const { ledger, primary, recovery } = fixture();
    primary.storedRecord = record();
    recovery.storedRecord = record({ reason: 'divergent stored material' });

    await expect(ledger.append(appendRequest())).rejects.toMatchObject({
      name: 'ControlLedgerIntegrityError',
      message:
        'Dual-region control ledger records differ at the target sequence',
    });
    expect(primary.appendRequests).toHaveLength(0);
    expect(recovery.appendRequests).toHaveLength(0);
  });

  it('rejects conflicting request material when equal records exist without writing', async () => {
    const { ledger, primary, recovery } = fixture();
    primary.storedRecord = record();
    recovery.storedRecord = record();

    await expect(
      ledger.append(appendRequest({ reason: 'conflicting request material' })),
    ).rejects.toBeInstanceOf(ControlLedgerConflictError);
    expect(primary.appendRequests).toHaveLength(0);
    expect(recovery.appendRequests).toHaveLength(0);
  });

  it('does not write the missing region for a different command', async () => {
    const { ledger, primary, recovery } = fixture();
    primary.storedRecord = record();

    await expect(
      ledger.append(appendRequest({ reason: 'different command material' })),
    ).rejects.toBeInstanceOf(ControlLedgerConflictError);
    expect(recovery.appendRequests).toHaveLength(0);
  });

  it.each([
    ['hash', { recordHash: '2'.repeat(64) }],
    ['content', { reason: 'different content' }],
  ])('fails integrity when returned %s differs', async (_name, override) => {
    const { ledger, recovery } = fixture();
    recovery.appendImplementation = () => Promise.resolve(record(override));
    await expect(ledger.append(appendRequest())).rejects.toBeInstanceOf(
      ControlLedgerIntegrityError,
    );
  });

  it('preserves a stable conflict when both regions reject the command', async () => {
    const { ledger, primary, recovery } = fixture();
    primary.appendImplementation = () =>
      Promise.reject(new ControlLedgerConflictError());
    recovery.appendImplementation = primary.appendImplementation;
    await expect(ledger.append(appendRequest())).rejects.toBeInstanceOf(
      ControlLedgerConflictError,
    );
  });

  it('classifies one success plus conflict as integrity divergence', async () => {
    const { ledger, recovery } = fixture();
    recovery.appendImplementation = () =>
      Promise.reject(new ControlLedgerConflictError());
    await expect(ledger.append(appendRequest())).rejects.toBeInstanceOf(
      ControlLedgerIntegrityError,
    );
  });

  it('preserves cancellation and waits for both operations to settle', async () => {
    const { ledger, primary, recovery } = fixture();
    const controller = new AbortController();
    let primarySettled = false;
    let recoverySettled = false;
    primary.appendImplementation = (request) =>
      rejectWhenAborted<ControlLedgerRecord>(
        request.signal,
        () => {
          primarySettled = true;
        },
        'regional append aborted',
      );
    recovery.appendImplementation = (request) =>
      rejectWhenAborted<ControlLedgerRecord>(
        request.signal,
        () => {
          recoverySettled = true;
        },
        'regional append aborted',
      );
    const reason = new Error('cancelled by caller');
    const pending = ledger.append(appendRequest({ signal: controller.signal }));
    await vi.waitFor(() => {
      expect(primary.appendRequests).toHaveLength(1);
      expect(recovery.appendRequests).toHaveLength(1);
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(primarySettled).toBe(true);
    expect(recoverySettled).toBe(true);
  });

  it('preserves cancellation when regional clients wrap the abort reason', async () => {
    const { ledger, primary, recovery } = fixture();
    const controller = new AbortController();
    const reason = new Error('wrapped cancellation');
    const rejectWrapped = (
      request: AppendControlLedgerRecord,
    ): Promise<ControlLedgerRecord> =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => {
            const cause: unknown = request.signal?.reason;
            reject(
              Object.assign(new Error('request aborted'), {
                cause,
                name: 'AbortError',
              }),
            );
          },
          { once: true },
        );
      });
    primary.appendImplementation = rejectWrapped;
    recovery.appendImplementation = rejectWrapped;
    const pending = ledger.append(appendRequest({ signal: controller.signal }));
    await vi.waitFor(() => {
      expect(primary.appendRequests).toHaveLength(1);
      expect(recovery.appendRequests).toHaveLength(1);
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('preserves cancellation after both append pre-reads settle', async () => {
    const { ledger, primary, recovery } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancelled during append pre-read');
    let primarySettled = false;
    let recoverySettled = false;
    primary.readImplementation = (request) =>
      rejectWhenAborted<ControlLedgerRecord | null>(
        request.signal,
        () => {
          primarySettled = true;
        },
        'regional read aborted',
      );
    recovery.readImplementation = (request) =>
      rejectWhenAborted<ControlLedgerRecord | null>(
        request.signal,
        () => {
          recoverySettled = true;
        },
        'regional read aborted',
      );

    const pending = ledger.append(appendRequest({ signal: controller.signal }));
    await vi.waitFor(() => {
      expect(primary.readRequests).toHaveLength(1);
      expect(recovery.readRequests).toHaveLength(1);
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(primarySettled).toBe(true);
    expect(recoverySettled).toBe(true);
    expect(primary.appendRequests).toHaveLength(0);
    expect(recovery.appendRequests).toHaveLength(0);
  });

  it('preserves cancellation after both public reads settle', async () => {
    const { ledger, primary, recovery } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancelled during public read');
    let primarySettled = false;
    let recoverySettled = false;
    primary.readImplementation = (request) =>
      rejectWhenAborted<ControlLedgerRecord | null>(
        request.signal,
        () => {
          primarySettled = true;
        },
        'regional read aborted',
      );
    recovery.readImplementation = (request) =>
      rejectWhenAborted<ControlLedgerRecord | null>(
        request.signal,
        () => {
          recoverySettled = true;
        },
        'regional read aborted',
      );

    const pending = ledger.read({
      sequence: 1,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    await vi.waitFor(() => {
      expect(primary.readRequests).toHaveLength(1);
      expect(recovery.readRequests).toHaveLength(1);
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(primarySettled).toBe(true);
    expect(recoverySettled).toBe(true);
  });

  it('preserves cancellation after both reconciliations settle', async () => {
    const { ledger, primary, recovery } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancelled during reconciliation');
    let primarySettled = false;
    let recoverySettled = false;
    primary.reconcileImplementation = (request) =>
      rejectWhenAborted<ControlLedgerReconciliation>(
        request.signal,
        () => {
          primarySettled = true;
        },
        'regional reconciliation aborted',
      );
    recovery.reconcileImplementation = (request) =>
      rejectWhenAborted<ControlLedgerReconciliation>(
        request.signal,
        () => {
          recoverySettled = true;
        },
        'regional reconciliation aborted',
      );

    const pending = ledger.reconcile({
      maxRecords: 10,
      projectedHash: ZERO_HASH,
      projectedSequence: 0,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    await vi.waitFor(() => {
      expect(primary.reconcileRequests).toHaveLength(1);
      expect(recovery.reconcileRequests).toHaveLength(1);
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(primarySettled).toBe(true);
    expect(recoverySettled).toBe(true);
  });

  it('requires reads to be present and exactly equal in both regions', async () => {
    const request = { sequence: 1, workspaceId: WORKSPACE_ID };
    const first = fixture();
    first.primary.readImplementation = () => Promise.resolve(record());
    first.recovery.readImplementation = () => Promise.resolve(null);
    await expect(first.ledger.read(request)).rejects.toThrow('records differ');

    const current = fixture();
    current.primary.readImplementation = () => Promise.resolve(record());
    current.recovery.readImplementation = () =>
      Promise.resolve(record({ reason: 'different' }));
    await expect(current.ledger.read(request)).rejects.toThrow(
      'records differ',
    );

    const missing = fixture();
    missing.primary.readImplementation = () => Promise.resolve(null);
    missing.recovery.readImplementation = () => Promise.resolve(null);
    await expect(missing.ledger.read(request)).resolves.toBeNull();
  });

  it.each([
    ['high water', { pageEndSequence: 2 }],
    ['page', { hasMore: true, reachedHighWater: false }],
  ])('fails reconciliation on %s mismatch', async (_name, override) => {
    const { ledger, primary, recovery } = fixture();
    recovery.reconcileImplementation = () =>
      Promise.resolve(reconciliation(override));
    const request = {
      maxRecords: 10,
      projectedHash: ZERO_HASH,
      projectedSequence: 0,
      workspaceId: WORKSPACE_ID,
    };
    await expect(ledger.reconcile(request)).rejects.toThrow('results differ');
    expect(primary.reconcileRequests[0]).toBe(recovery.reconcileRequests[0]);
  });

  it('returns exactly equal regional reconciliation pages', async () => {
    const { ledger } = fixture();
    await expect(
      ledger.reconcile({
        maxRecords: 10,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual(reconciliation());
  });

  it('fails reconciliation closed during either-region outage', async () => {
    const { ledger, recovery } = fixture();
    recovery.reconcileImplementation = () =>
      Promise.reject(new Error('region unavailable'));
    await expect(
      ledger.reconcile({
        maxRecords: 10,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ControlLedgerIntegrityError);
  });

  it('records one bounded coordinator signal for a regional read outage', async () => {
    const observations: unknown[] = [];
    const { ledger, recovery } = fixture({
      observeRequest: () => undefined,
      observeSafetyViolation: (observation) => observations.push(observation),
    });
    recovery.readImplementation = () =>
      Promise.reject(new Error('region unavailable'));

    await expect(
      ledger.read({ sequence: 1, workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ControlLedgerIntegrityError);
    expect(observations).toEqual([
      {
        check: 'control_ledger_integrity',
        failedRegionRole: 'recovery',
        operation: 'read',
        outcome: 'unavailable',
        regionRole: 'primary',
        surface: 'control_ledger',
      },
    ]);
  });

  it('exposes only an exact common prefix for matching one-sided repair', async () => {
    const { ledger, primary, recovery } = fixture();
    primary.reconcileImplementation = () =>
      Promise.resolve(
        reconciliation({
          pageEndHash: ZERO_HASH,
          pageEndSequence: 0,
          records: [],
        }),
      );
    const request = {
      maxRecords: 10,
      projectedHash: ZERO_HASH,
      projectedSequence: 0,
      repairCommandId: COMMAND_ID,
      workspaceId: WORKSPACE_ID,
    };

    await expect(ledger.reconcile(request)).resolves.toEqual({
      hasMore: false,
      pageEndHash: ZERO_HASH,
      pageEndSequence: 0,
      reachedHighWater: true,
      records: [],
    });
    await expect(
      ledger.reconcile({ ...request, repairCommandId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(ControlLedgerIntegrityError);
    expect(primary.reconcileRequests[0]).toBe(recovery.reconcileRequests[0]);
  });

  it('rejects reverse one-sided reconciliation without the exact repair command', async () => {
    const { ledger, recovery } = fixture();
    recovery.reconcileImplementation = () =>
      Promise.resolve(
        reconciliation({
          pageEndHash: ZERO_HASH,
          pageEndSequence: 0,
          records: [],
        }),
      );

    await expect(
      ledger.reconcile({
        maxRecords: 10,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        repairCommandId: crypto.randomUUID(),
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ControlLedgerIntegrityError);
  });

  it('accepts a recovery-shorter exact common prefix', async () => {
    const { ledger, recovery } = fixture();
    recovery.reconcileImplementation = () =>
      Promise.resolve(
        reconciliation({
          pageEndHash: ZERO_HASH,
          pageEndSequence: 0,
          records: [],
        }),
      );

    await expect(
      ledger.reconcile({
        maxRecords: 10,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        repairCommandId: COMMAND_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual({
      hasMore: false,
      pageEndHash: ZERO_HASH,
      pageEndSequence: 0,
      reachedHighWater: true,
      records: [],
    });
  });

  it('rejects a structurally incomplete one-sided repair page', async () => {
    const { ledger, primary } = fixture();
    primary.reconcileImplementation = () =>
      Promise.resolve(
        reconciliation({
          hasMore: true,
          pageEndHash: ZERO_HASH,
          pageEndSequence: 0,
          reachedHighWater: false,
          records: [],
        }),
      );

    await expect(
      ledger.reconcile({
        maxRecords: 10,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        repairCommandId: COMMAND_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ControlLedgerIntegrityError);
  });

  it('closes owned ledgers and leaves explicitly borrowed ledgers open', async () => {
    const borrowed = fixture();
    borrowed.ledger.close();
    borrowed.ledger.close();
    expect(borrowed.primary.closeCalls).toBe(0);
    expect(borrowed.recovery.closeCalls).toBe(0);

    const primary = new FakeLedger('ledger-primary', 'eu-central-1');
    const recovery = new FakeLedger('ledger-recovery', 'eu-west-1');
    const owned = createDualRegionControlLedger(primary, recovery, {
      ledgerOwnership: 'owned',
    });
    owned.close();
    owned.close();
    expect(primary.closeCalls).toBe(1);
    expect(recovery.closeCalls).toBe(1);
    expect('delete' in owned).toBe(false);
    expect('list' in owned).toBe(false);
    expect('repair' in owned).toBe(false);
    await expect(
      owned.read({ sequence: 1, workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ControlLedgerClosedError);
  });

  it('attempts both owned closes and aggregates failures', () => {
    const primary = new FakeLedger('ledger-primary', 'eu-central-1');
    const recovery = new FakeLedger('ledger-recovery', 'eu-west-1');
    primary.close = () => {
      primary.closeCalls += 1;
      throw new Error('primary close failed');
    };
    recovery.close = () => {
      recovery.closeCalls += 1;
      throw new Error('recovery close failed');
    };
    const ledger = createDualRegionControlLedger(primary, recovery, {
      ledgerOwnership: 'owned',
    });

    expect(() => {
      ledger.close();
    }).toThrow(AggregateError);
    expect(primary.closeCalls).toBe(1);
    expect(recovery.closeCalls).toBe(1);
  });
});
