import type { ControlLedgerConfig } from './control-ledger-config.js';
import {
  ControlLedgerClosedError,
  ControlLedgerConflictError,
  ControlLedgerIntegrityError,
  ControlLedgerReadinessError,
  createControlLedger,
} from './control-ledger.js';
import type {
  AppendControlLedgerRecord,
  ControlLedger,
  ControlLedgerReadiness,
  ControlLedgerReadRequest,
  ControlLedgerReconciliation,
  ControlLedgerRecord,
  ReconcileControlLedgerRequest,
} from './control-ledger.js';
import {
  createProductionObjectStoreObserver,
  safelyObserveSafetyViolation,
} from './object-store-telemetry.js';
import type { ObjectStoreObserver } from './object-store-telemetry.js';

export interface DualRegionControlLedgerReadiness extends ControlLedgerReadiness {
  readonly primary: ControlLedgerReadiness;
  readonly recovery: ControlLedgerReadiness;
}

export interface DualRegionControlLedger extends ControlLedger {
  checkReadiness(
    signal?: AbortSignal,
  ): Promise<DualRegionControlLedgerReadiness>;
}

export class ControlLedgerPartialReplicationError extends Error {
  public constructor() {
    super(
      'Control ledger append was only partially replicated; retry the exact command',
    );
    this.name = 'ControlLedgerPartialReplicationError';
  }
}

function exactEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => exactEqual(item, right[index]))
    );
  }
  const leftEntries = Object.entries(left).filter(
    ([, value]) => value !== undefined,
  );
  const rightEntries = Object.entries(right).filter(
    ([, value]) => value !== undefined,
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) =>
      Object.hasOwn(right, key)
        ? exactEqual(value, (right as Record<string, unknown>)[key])
        : false,
    )
  );
}

function requestMaterialMatches(
  record: ControlLedgerRecord,
  request: AppendControlLedgerRecord,
): boolean {
  const { recordHash, schemaVersion, ...material } = record;
  const { signal, ...requested } = request;
  void recordHash;
  void schemaVersion;
  void signal;
  return exactEqual(material, requested);
}

function throwCancellation(signal: AbortSignal | undefined): never {
  signal?.throwIfAborted();
  throw new ControlLedgerIntegrityError(
    'Dual-region control ledger operation could not be proven',
  );
}

function isConflict(result: PromiseSettledResult<unknown>): boolean {
  return (
    result.status === 'rejected' &&
    result.reason instanceof ControlLedgerConflictError
  );
}

function failedRegionRole(
  primary: PromiseSettledResult<unknown>,
  recovery: PromiseSettledResult<unknown>,
): 'primary' | 'recovery' | 'both' | 'none' {
  if (primary.status === 'rejected' && recovery.status === 'rejected')
    return 'both';
  if (primary.status === 'rejected') return 'primary';
  if (recovery.status === 'rejected') return 'recovery';
  return 'none';
}

type ObserveCoordinatorFailure = (
  operation: 'append' | 'read' | 'readiness' | 'reconcile',
  outcome: 'diverged' | 'partial' | 'unavailable',
  failedRole: 'primary' | 'recovery' | 'both' | 'none',
) => void;

function classifyAppend(
  primary: PromiseSettledResult<ControlLedgerRecord>,
  recovery: PromiseSettledResult<ControlLedgerRecord>,
  signal?: AbortSignal,
  observe?: ObserveCoordinatorFailure,
): ControlLedgerRecord {
  if (primary.status === 'fulfilled' && recovery.status === 'fulfilled') {
    if (!exactEqual(primary.value, recovery.value)) {
      observe?.('append', 'diverged', 'both');
      throw new ControlLedgerIntegrityError(
        'Dual-region control ledger append results differ',
      );
    }
    return primary.value;
  }
  if (primary.status === 'fulfilled' || recovery.status === 'fulfilled') {
    const rejected = primary.status === 'rejected' ? primary : recovery;
    if (isConflict(rejected)) {
      observe?.('append', 'diverged', failedRegionRole(primary, recovery));
      throw new ControlLedgerIntegrityError(
        'Dual-region control ledger append diverged at the target sequence',
      );
    }
    observe?.('append', 'partial', failedRegionRole(primary, recovery));
    throw new ControlLedgerPartialReplicationError();
  }
  if (isConflict(primary) && isConflict(recovery)) {
    throw new ControlLedgerConflictError();
  }
  if (signal?.aborted === true) {
    throwCancellation(signal);
  }
  observe?.('append', 'unavailable', 'both');
  throw new ControlLedgerIntegrityError(
    'Dual-region control ledger append could not be proven',
  );
}

class CoordinatedDualRegionControlLedger implements DualRegionControlLedger {
  private closed = false;

  public constructor(
    private readonly primary: ControlLedger,
    private readonly recovery: ControlLedger,
    private readonly ownsLedgers: boolean,
    private readonly observer?: ObjectStoreObserver,
  ) {}

  private readonly observeCoordinatorFailure: ObserveCoordinatorFailure = (
    operation,
    outcome,
    failedRole,
  ) => {
    safelyObserveSafetyViolation(this.observer, {
      check: 'control_ledger_integrity',
      failedRegionRole: failedRole,
      operation,
      outcome,
      regionRole: 'primary',
      surface: 'control_ledger',
    });
  };

  public async append(
    request: AppendControlLedgerRecord,
  ): Promise<ControlLedgerRecord> {
    this.assertOpen();
    await this.checkReadiness(request.signal);
    const readRequest: ControlLedgerReadRequest = {
      sequence: request.sequence,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      workspaceId: request.workspaceId,
    };
    const [primaryExisting, recoveryExisting] = await Promise.allSettled([
      this.primary.read(readRequest),
      this.recovery.read(readRequest),
    ]);
    if (
      primaryExisting.status === 'rejected' ||
      recoveryExisting.status === 'rejected'
    ) {
      if (request.signal?.aborted === true) throwCancellation(request.signal);
      this.observeCoordinatorFailure(
        'append',
        'unavailable',
        failedRegionRole(primaryExisting, recoveryExisting),
      );
      throw new ControlLedgerIntegrityError(
        'Dual-region control ledger append pre-read could not be proven',
      );
    }
    const primaryRecord = primaryExisting.value;
    const recoveryRecord = recoveryExisting.value;
    if (primaryRecord !== null && recoveryRecord !== null) {
      if (!exactEqual(primaryRecord, recoveryRecord)) {
        this.observeCoordinatorFailure('append', 'diverged', 'both');
        throw new ControlLedgerIntegrityError(
          'Dual-region control ledger records differ at the target sequence',
        );
      }
      if (!requestMaterialMatches(primaryRecord, request)) {
        throw new ControlLedgerConflictError();
      }
      return primaryRecord;
    }
    if (primaryRecord !== null || recoveryRecord !== null) {
      const present = primaryRecord ?? recoveryRecord;
      if (present === null || !requestMaterialMatches(present, request)) {
        throw new ControlLedgerConflictError();
      }
      const repaired = await Promise.allSettled([
        primaryRecord === null
          ? this.primary.append(request)
          : Promise.resolve(primaryRecord),
        recoveryRecord === null
          ? this.recovery.append(request)
          : Promise.resolve(recoveryRecord),
      ]);
      return classifyAppend(
        repaired[0],
        repaired[1],
        request.signal,
        this.observeCoordinatorFailure,
      );
    }
    const appended = await Promise.allSettled([
      this.primary.append(request),
      this.recovery.append(request),
    ]);
    return classifyAppend(
      appended[0],
      appended[1],
      request.signal,
      this.observeCoordinatorFailure,
    );
  }

  public async checkReadiness(
    signal?: AbortSignal,
  ): Promise<DualRegionControlLedgerReadiness> {
    this.assertOpen();
    const [primary, recovery] = await Promise.allSettled([
      this.primary.checkReadiness(signal),
      this.recovery.checkReadiness(signal),
    ]);
    if (signal?.aborted === true) throwCancellation(signal);
    if (primary.status === 'rejected' || recovery.status === 'rejected') {
      this.observeCoordinatorFailure(
        'readiness',
        'unavailable',
        failedRegionRole(primary, recovery),
      );
      throw new ControlLedgerReadinessError(
        'Dual-region control ledger readiness could not be verified',
      );
    }
    if (
      primary.value.bucket === recovery.value.bucket ||
      primary.value.region === recovery.value.region
    ) {
      safelyObserveSafetyViolation(this.observer, {
        check: 'region_isolation',
        failedRegionRole: 'both',
        operation: 'readiness',
        outcome: 'diverged',
        regionRole: 'primary',
        surface: 'control_ledger',
      });
      throw new ControlLedgerReadinessError(
        'Control ledger primary and recovery regions and buckets must be distinct',
      );
    }
    return Object.freeze({
      bucket: primary.value.bucket,
      minRetentionDays: Math.min(
        primary.value.minRetentionDays,
        recovery.value.minRetentionDays,
      ),
      prefix: 'control-ledger/workspaces/' as const,
      primary: primary.value,
      recovery: recovery.value,
      region: primary.value.region,
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.ownsLedgers) return;
    const errors: unknown[] = [];
    try {
      this.primary.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      this.recovery.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Dual-region control ledgers could not be closed',
      );
    }
  }

  public async read(
    request: ControlLedgerReadRequest,
  ): Promise<ControlLedgerRecord | null> {
    this.assertOpen();
    await this.checkReadiness(request.signal);
    const [primary, recovery] = await Promise.allSettled([
      this.primary.read(request),
      this.recovery.read(request),
    ]);
    if (primary.status === 'rejected' || recovery.status === 'rejected') {
      if (request.signal?.aborted === true) throwCancellation(request.signal);
      this.observeCoordinatorFailure(
        'read',
        'unavailable',
        failedRegionRole(primary, recovery),
      );
      throw new ControlLedgerIntegrityError(
        'Dual-region control ledger read could not be proven',
      );
    }
    if (!exactEqual(primary.value, recovery.value)) {
      this.observeCoordinatorFailure('read', 'diverged', 'both');
      throw new ControlLedgerIntegrityError(
        'Dual-region control ledger records differ',
      );
    }
    return primary.value;
  }

  public async reconcile(
    request: ReconcileControlLedgerRequest,
  ): Promise<ControlLedgerReconciliation> {
    this.assertOpen();
    await this.checkReadiness(request.signal);
    const [primary, recovery] = await Promise.allSettled([
      this.primary.reconcile(request),
      this.recovery.reconcile(request),
    ]);
    if (primary.status === 'rejected' || recovery.status === 'rejected') {
      if (request.signal?.aborted === true) throwCancellation(request.signal);
      this.observeCoordinatorFailure(
        'reconcile',
        'unavailable',
        failedRegionRole(primary, recovery),
      );
      throw new ControlLedgerIntegrityError(
        'Dual-region control ledger reconciliation could not be proven',
      );
    }
    if (exactEqual(primary.value, recovery.value)) return primary.value;
    if (
      request.repairCommandId !== undefined &&
      this.repairableCommonPrefix(primary.value, recovery.value, request)
    ) {
      return primary.value.records.length < recovery.value.records.length
        ? primary.value
        : recovery.value;
    }
    this.observeCoordinatorFailure('reconcile', 'diverged', 'both');
    throw new ControlLedgerIntegrityError(
      'Dual-region control ledger reconciliation results differ',
    );
  }

  private repairableCommonPrefix(
    primary: ControlLedgerReconciliation,
    recovery: ControlLedgerReconciliation,
    request: ReconcileControlLedgerRequest,
  ): boolean {
    const shorter =
      primary.records.length < recovery.records.length ? primary : recovery;
    const longer = shorter === primary ? recovery : primary;
    if (
      longer.records.length !== shorter.records.length + 1 ||
      shorter.hasMore ||
      longer.hasMore ||
      !shorter.reachedHighWater ||
      !longer.reachedHighWater ||
      !exactEqual(
        shorter.records,
        longer.records.slice(0, shorter.records.length),
      ) ||
      shorter.pageEndSequence !==
        (shorter.records.at(-1)?.sequence ?? request.projectedSequence) ||
      shorter.pageEndHash !==
        (shorter.records.at(-1)?.recordHash ?? request.projectedHash)
    ) {
      return false;
    }
    const extra = longer.records.at(-1);
    if (extra === undefined) return false;
    return (
      extra.commandId === request.repairCommandId &&
      extra.sequence === shorter.pageEndSequence + 1 &&
      extra.previousHash === shorter.pageEndHash &&
      longer.pageEndSequence === extra.sequence &&
      longer.pageEndHash === extra.recordHash
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new ControlLedgerClosedError();
  }
}

export function createDualRegionControlLedger(
  primary: ControlLedgerConfig,
  recovery: ControlLedgerConfig,
  options?: Readonly<{ observer?: ObjectStoreObserver }>,
): DualRegionControlLedger;
export function createDualRegionControlLedger(
  primary: ControlLedger,
  recovery: ControlLedger,
  options: Readonly<{
    ledgerOwnership: 'borrowed' | 'owned';
    observer?: ObjectStoreObserver;
  }>,
): DualRegionControlLedger;
export function createDualRegionControlLedger(
  primary: ControlLedgerConfig | ControlLedger,
  recovery: ControlLedgerConfig | ControlLedger,
  options?: Readonly<{
    ledgerOwnership?: 'borrowed' | 'owned';
    observer?: ObjectStoreObserver;
  }>,
): DualRegionControlLedger {
  const observer = options?.observer ?? createProductionObjectStoreObserver();
  const suppliedLedgers = 'append' in primary && 'append' in recovery;
  if (suppliedLedgers) {
    if (options === undefined) {
      throw new TypeError(
        'Injected control ledgers require explicit ownership',
      );
    }
    return new CoordinatedDualRegionControlLedger(
      primary,
      recovery,
      options.ledgerOwnership === 'owned',
      observer,
    );
  }
  if (
    'append' in primary ||
    'append' in recovery ||
    options?.ledgerOwnership !== undefined
  ) {
    throw new TypeError('Primary and recovery must both be configs or ledgers');
  }
  if (
    primary.region === recovery.region ||
    primary.bucket === recovery.bucket ||
    primary.accessKeyId === recovery.accessKeyId
  ) {
    throw new TypeError(
      'Control ledger primary and recovery regions, buckets, and access key IDs must be distinct',
    );
  }
  return new CoordinatedDualRegionControlLedger(
    createControlLedger(primary, {
      observer,
      regionRole: 'primary',
    }),
    createControlLedger(recovery, {
      observer,
      regionRole: 'recovery',
    }),
    true,
    observer,
  );
}
