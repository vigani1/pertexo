import { Pool, type PoolClient, type QueryConfig, type QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';

const ZERO_HASH = '0'.repeat(64);
const BACKEND_CANCELLATION_TIMEOUT_MS = 1_000;
const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const occurredAtSchema = z.iso
  .datetime({ offset: true })
  .transform((value, context) => {
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) {
      context.addIssue({ code: 'custom', message: 'Invalid occurredAt' });
      return z.NEVER;
    }
    return date.toISOString();
  });

export type LegalHoldCommandType = 'legal_hold_placed' | 'legal_hold_released';
export type ControlLedgerCommandType =
  | LegalHoldCommandType
  | 'deletion_requested'
  | 'deletion_restored'
  | 'purge_started'
  | 'deletion_completed';

export interface ControlLedgerRecord {
  readonly actorRef: string;
  readonly commandId: string;
  readonly commandType: ControlLedgerCommandType;
  readonly legalAuthority?: string;
  readonly occurredAt: string;
  readonly previousHash: string;
  readonly reason: string;
  readonly recordHash: string;
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly subjectId: string;
  readonly workspaceId: string;
}

export interface AppendControlLedgerRecord {
  readonly actorRef: string;
  readonly commandId: string;
  readonly commandType: LegalHoldCommandType;
  readonly legalAuthority: string;
  readonly occurredAt: string;
  readonly previousHash: string;
  readonly reason: string;
  readonly sequence: number;
  readonly signal?: AbortSignal;
  readonly subjectId: string;
  readonly workspaceId: string;
}

export interface ControlLedgerReconciliation {
  readonly hasMore: boolean;
  readonly pageEndHash: string;
  readonly pageEndSequence: number;
  readonly reachedHighWater: boolean;
  readonly records: readonly ControlLedgerRecord[];
}

export interface ControlLedger {
  append(request: AppendControlLedgerRecord): Promise<ControlLedgerRecord>;
  reconcile(request: {
    readonly maxRecords: number;
    readonly projectedHash: string;
    readonly projectedSequence: number;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<ControlLedgerReconciliation>;
}

export interface LegalHoldCommandInput {
  readonly actorRef: string;
  readonly commandId: string;
  readonly holdId: string;
  readonly legalAuthority: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

export interface LegalHoldCommandResult {
  readonly commandId: string;
  readonly commandType: LegalHoldCommandType;
  readonly holdId: string;
  readonly recordHash: string;
  readonly replayed: boolean;
  readonly sequence: number;
  readonly workspaceId: string;
}

export interface ControlLedgerReconcileResult {
  readonly highWaterHash: string;
  readonly highWaterSequence: number;
  readonly projectedCount: number;
  readonly workspaceId: string;
}

export interface ControlLedgerCoordinator {
  close(): Promise<void>;
  placeLegalHold(input: LegalHoldCommandInput): Promise<LegalHoldCommandResult>;
  reconcileWorkspace(input: {
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<ControlLedgerReconcileResult>;
  releaseLegalHold(
    input: LegalHoldCommandInput,
  ): Promise<LegalHoldCommandResult>;
}

export class ControlLedgerCommandConflictError extends Error {
  public constructor() {
    super('Control ledger command replay conflicts with the requested payload');
    this.name = 'ControlLedgerCommandConflictError';
  }
}

export class ControlLedgerReconciliationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlLedgerReconciliationError';
  }
}

export class ControlLedgerReconciliationBoundError extends ControlLedgerReconciliationError {
  public constructor() {
    super('Control ledger reconciliation invocation bound exceeded');
    this.name = 'ControlLedgerReconciliationBoundError';
  }
}

interface MaintenancePool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

interface ProjectionRow {
  [key: string]: unknown;
  actor_ref: string;
  command_id: string;
  command_type: string;
  legal_authority: string | null;
  occurred_at: Date | string;
  previous_hash: string;
  reason: string;
  record_hash: string;
  sequence: string | number;
  subject_id: string;
}

interface HighWater {
  hash: string;
  sequence: number;
}

const optionsSchema = z.object({
  externalOperationTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(120_000),
  lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  maxPages: z.number().int().min(1).max(1_000).default(10),
  maxRecords: z.number().int().min(1).max(1_000).default(1_000),
  pageSize: z.number().int().min(1).max(100).default(100),
  statementTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

function parseInput(input: LegalHoldCommandInput) {
  return z
    .object({
      actorRef: boundedText(128),
      commandId: uuidSchema,
      holdId: uuidSchema,
      legalAuthority: boundedText(256),
      occurredAt: occurredAtSchema,
      reason: boundedText(512),
      signal: z
        .custom<AbortSignal>((value) => value instanceof AbortSignal)
        .optional(),
      workspaceId: uuidSchema,
    })
    .strict()
    .parse(input);
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function query<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] = [],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  throwIfAborted(signal);
  let result: QueryResult<Row>;
  try {
    result = await client.query<Row>({
      text,
      values: [...values],
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) throw signal.reason;
    throw error;
  }
  throwIfAborted(signal);
  return result;
}

async function acquirePoolClient(
  pool: MaintenancePool,
  signal?: AbortSignal,
): Promise<PoolClient> {
  const connection = pool.connect();
  if (signal === undefined) return connection;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([connection, aborted]);
  } catch (error: unknown) {
    if (signal.aborted) {
      void connection.then(
        (client) => {
          client.release();
        },
        () => undefined,
      );
      throw signal.reason;
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function externalSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => {
      finish(() => {
        // AbortSignal reasons are intentionally preserved even when non-Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason);
      });
    };
    operation.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          // Preserve the adapter's rejection value unchanged.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        });
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function cancelBackendQuery(
  config: DatabaseConfig,
  processId: number,
): Promise<void> {
  const cancellationPool = new Pool({
    ...config,
    connectionTimeoutMillis: Math.min(
      config.connectionTimeoutMillis,
      BACKEND_CANCELLATION_TIMEOUT_MS,
    ),
    max: 1,
  });
  const signal = AbortSignal.timeout(BACKEND_CANCELLATION_TIMEOUT_MS);
  const cancellationQuery: QueryConfig<number[]> & {
    readonly signal: AbortSignal;
  } = {
    text: 'select pg_cancel_backend($1)',
    values: [processId],
    signal,
  };
  try {
    await raceWithSignal(cancellationPool.query(cancellationQuery), signal);
  } catch {
    // Backend cancellation is best effort; transaction rollback is authoritative.
  } finally {
    const endSignal = AbortSignal.timeout(BACKEND_CANCELLATION_TIMEOUT_MS);
    await raceWithSignal(cancellationPool.end(), endSignal).catch(
      () => undefined,
    );
  }
}

function numberSequence(value: string | number): number {
  const sequence = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new ControlLedgerReconciliationError(
      'Database control high water is invalid',
    );
  return sequence;
}

function assertRecord(
  record: ControlLedgerRecord,
  workspaceId: string,
  expected: HighWater,
): void {
  if (
    record.workspaceId !== workspaceId ||
    record.schemaVersion !== 1 ||
    record.sequence !== expected.sequence + 1 ||
    record.previousHash !== expected.hash ||
    !hashSchema.safeParse(record.recordHash).success ||
    record.recordHash === record.previousHash
  )
    throw new ControlLedgerReconciliationError(
      'External control ledger record chain is invalid',
    );
  if (
    record.commandType !== 'legal_hold_placed' &&
    record.commandType !== 'legal_hold_released'
  )
    throw new ControlLedgerReconciliationError(
      `Unsupported control ledger command: ${record.commandType}`,
    );
  z.object({
    actorRef: boundedText(128),
    commandId: uuidSchema,
    legalAuthority: boundedText(256),
    occurredAt: occurredAtSchema,
    reason: boundedText(512),
    subjectId: uuidSchema,
  }).parse(record);
}

async function project(
  client: PoolClient,
  record: ControlLedgerRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await query<{ project_workspace_legal_hold: boolean }>(
    client,
    `select app.project_workspace_legal_hold(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
     ) project_workspace_legal_hold`,
    [
      record.workspaceId,
      record.sequence,
      record.commandId,
      record.commandType,
      record.subjectId,
      record.previousHash,
      record.recordHash,
      record.actorRef,
      record.legalAuthority,
      record.reason,
      record.occurredAt,
    ],
    signal,
  );
  return result.rows[0]?.project_workspace_legal_hold === true;
}

export function createControlLedgerCoordinator(
  config: DatabaseConfig,
  ledger: ControlLedger,
  options: Readonly<{
    externalOperationTimeoutMs?: number;
    lockTimeoutMs?: number;
    maxPages?: number;
    maxRecords?: number;
    pageSize?: number;
    pool?: MaintenancePool;
    statementTimeoutMs?: number;
  }> = {},
): ControlLedgerCoordinator {
  const parsed = optionsSchema.parse(options);
  const parsedOptions = {
    ...parsed,
    maxRecords:
      options.maxRecords ??
      Math.min(parsed.maxRecords, parsed.maxPages * parsed.pageSize),
  };
  if (parsedOptions.pageSize > parsedOptions.maxRecords)
    throw new Error('Control ledger page size cannot exceed the record bound');
  if (
    parsedOptions.maxRecords >
    parsedOptions.maxPages * parsedOptions.pageSize
  )
    throw new Error('Control ledger record bound cannot exceed page capacity');
  const pool = options.pool ?? new Pool(config);
  const ownsPool = options.pool === undefined;

  const transact = async <T>(
    workspaceId: string,
    signal: AbortSignal | undefined,
    operation: (client: PoolClient, highWater: HighWater) => Promise<T>,
  ): Promise<T> => {
    throwIfAborted(signal);
    const client = await acquirePoolClient(pool, signal);
    const processId = (client as PoolClient & { processID?: number }).processID;
    const cancellation = { requested: false };
    const cancelForAbort = (): void => {
      cancellation.requested = true;
      if (processId !== undefined)
        void cancelBackendQuery(config, processId).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancelForAbort, { once: true });
    try {
      await query(client, 'begin', [], signal);
      await query(
        client,
        `set local lock_timeout='${String(parsedOptions.lockTimeoutMs)}ms';
         set local statement_timeout='${String(parsedOptions.statementTimeoutMs)}ms';
         set local idle_in_transaction_session_timeout='0'`,
        [],
        signal,
      );
      const locked = await query<{
        retention_control_hash: string;
        retention_control_sequence: string | number;
      }>(
        client,
        'select * from app.lock_workspace_control_ledger($1)',
        [workspaceId],
        signal,
      );
      const row = locked.rows[0];
      if (
        row === undefined ||
        locked.rowCount !== 1 ||
        !hashSchema.safeParse(row.retention_control_hash).success
      )
        throw new ControlLedgerReconciliationError(
          'Workspace control lock returned invalid high water',
        );
      const result = await operation(client, {
        hash: row.retention_control_hash,
        sequence: numberSequence(row.retention_control_sequence),
      });
      throwIfAborted(signal);
      await query(client, 'commit', [], signal);
      signal?.removeEventListener('abort', cancelForAbort);
      client.release(
        cancellation.requested
          ? new Error('Control ledger transaction was canceled')
          : undefined,
      );
      return result;
    } catch (error: unknown) {
      let rollbackError: unknown;
      try {
        await client.query({ text: 'rollback' });
      } catch (caught: unknown) {
        rollbackError = caught;
      }
      signal?.removeEventListener('abort', cancelForAbort);
      client.release(
        rollbackError instanceof Error
          ? rollbackError
          : cancellation.requested
            ? new Error('Control ledger transaction was canceled')
            : rollbackError === undefined
              ? undefined
              : new Error('Control ledger transaction could not roll back'),
      );
      throw error;
    }
  };

  const reconcileChunk = async (
    client: PoolClient,
    workspaceId: string,
    initial: HighWater,
    maximumRecords: number,
    signal?: AbortSignal,
  ): Promise<
    ControlLedgerReconcileResult & { readonly reachedHighWater: boolean }
  > => {
    let highWater = initial;
    let projectedCount = 0;
    const requested = Math.min(parsedOptions.pageSize, maximumRecords);
    const operationSignal = externalSignal(
      signal,
      parsedOptions.externalOperationTimeoutMs,
    );
    const response = await raceWithSignal(
      ledger.reconcile({
        maxRecords: requested,
        projectedHash: highWater.hash,
        projectedSequence: highWater.sequence,
        signal: operationSignal,
        workspaceId,
      }),
      operationSignal,
    );
    if (
      response.records.length > requested ||
      response.hasMore === response.reachedHighWater ||
      (response.hasMore && response.records.length === 0)
    )
      throw new ControlLedgerReconciliationError(
        'External control ledger page contract is invalid',
      );
    for (const record of response.records) {
      assertRecord(record, workspaceId, highWater);
      await project(client, record, signal);
      highWater = { hash: record.recordHash, sequence: record.sequence };
      projectedCount += 1;
    }
    if (
      response.pageEndSequence !== highWater.sequence ||
      response.pageEndHash !== highWater.hash
    )
      throw new ControlLedgerReconciliationError(
        'External control ledger page high water is invalid',
      );
    return Object.freeze({
      highWaterHash: highWater.hash,
      highWaterSequence: highWater.sequence,
      projectedCount,
      reachedHighWater: response.reachedHighWater,
      workspaceId,
    });
  };

  const reconcileWorkspace = async (
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<ControlLedgerReconcileResult> => {
    let projectedCount = 0;
    for (let page = 0; page < parsedOptions.maxPages; page += 1) {
      const remaining = parsedOptions.maxRecords - projectedCount;
      if (remaining < 1) break;
      const chunk = await transact(workspaceId, signal, (client, highWater) =>
        reconcileChunk(client, workspaceId, highWater, remaining, signal),
      );
      projectedCount += chunk.projectedCount;
      if (chunk.reachedHighWater)
        return Object.freeze({
          highWaterHash: chunk.highWaterHash,
          highWaterSequence: chunk.highWaterSequence,
          projectedCount,
          workspaceId,
        });
    }
    throw new ControlLedgerReconciliationBoundError();
  };

  const command = async (
    commandType: LegalHoldCommandType,
    input: LegalHoldCommandInput,
  ): Promise<LegalHoldCommandResult> => {
    const parsed = parseInput(input);
    let projectedCount = 0;
    for (let page = 0; page < parsedOptions.maxPages; page += 1) {
      const remaining = parsedOptions.maxRecords - projectedCount;
      if (remaining < 1) break;
      const outcome = await transact(
        parsed.workspaceId,
        parsed.signal,
        async (client, initial) => {
          const reconciled = await reconcileChunk(
            client,
            parsed.workspaceId,
            initial,
            remaining,
            parsed.signal,
          );
          if (!reconciled.reachedHighWater)
            return {
              kind: 'progress' as const,
              projectedCount: reconciled.projectedCount,
            };
          const existing = await query<ProjectionRow>(
            client,
            'select * from app.read_workspace_control_command($1,$2)',
            [parsed.workspaceId, parsed.commandId],
            parsed.signal,
          );
          const row = existing.rows[0];
          if (row !== undefined) {
            const occurredAt = new Date(row.occurred_at).toISOString();
            if (
              row.command_type !== commandType ||
              row.subject_id !== parsed.holdId ||
              row.actor_ref !== parsed.actorRef ||
              row.legal_authority !== parsed.legalAuthority ||
              row.reason !== parsed.reason ||
              occurredAt !== parsed.occurredAt
            )
              throw new ControlLedgerCommandConflictError();
            return {
              kind: 'command' as const,
              result: Object.freeze({
                commandId: row.command_id,
                commandType,
                holdId: row.subject_id,
                recordHash: row.record_hash,
                replayed: true,
                sequence: numberSequence(row.sequence),
                workspaceId: parsed.workspaceId,
              }),
            };
          }

          await query(
            client,
            'select app.validate_workspace_legal_hold_command($1,$2,$3)',
            [parsed.workspaceId, commandType, parsed.holdId],
            parsed.signal,
          );

          const appendSignal = externalSignal(
            parsed.signal,
            parsedOptions.externalOperationTimeoutMs,
          );
          const appendInput: AppendControlLedgerRecord = {
            actorRef: parsed.actorRef,
            commandId: parsed.commandId,
            commandType,
            legalAuthority: parsed.legalAuthority,
            occurredAt: parsed.occurredAt,
            previousHash: reconciled.highWaterHash,
            reason: parsed.reason,
            sequence: reconciled.highWaterSequence + 1,
            signal: appendSignal,
            subjectId: parsed.holdId,
            workspaceId: parsed.workspaceId,
          };
          // A timed-out conditional append is recovered by reconciliation on retry.
          const appended = await raceWithSignal(
            ledger.append(appendInput),
            appendSignal,
          );
          assertRecord(appended, parsed.workspaceId, {
            hash: reconciled.highWaterHash,
            sequence: reconciled.highWaterSequence,
          });
          if (
            appended.commandId !== appendInput.commandId ||
            appended.commandType !== appendInput.commandType ||
            appended.subjectId !== appendInput.subjectId ||
            appended.actorRef !== appendInput.actorRef ||
            appended.legalAuthority !== appendInput.legalAuthority ||
            appended.reason !== appendInput.reason ||
            appended.occurredAt !== appendInput.occurredAt
          )
            throw new ControlLedgerCommandConflictError();
          await project(client, appended, parsed.signal);
          return {
            kind: 'command' as const,
            result: Object.freeze({
              commandId: appended.commandId,
              commandType,
              holdId: appended.subjectId,
              recordHash: appended.recordHash,
              replayed: false,
              sequence: appended.sequence,
              workspaceId: appended.workspaceId,
            }),
          };
        },
      );
      if (outcome.kind === 'command') return outcome.result;
      projectedCount += outcome.projectedCount;
    }
    throw new ControlLedgerReconciliationBoundError();
  };

  return Object.freeze({
    close: async (): Promise<void> => {
      if (ownsPool) await pool.end();
    },
    placeLegalHold: (input: LegalHoldCommandInput) =>
      command('legal_hold_placed', input),
    reconcileWorkspace: (input: {
      readonly signal?: AbortSignal;
      readonly workspaceId: string;
    }) => {
      const parsed = z
        .object({
          signal: z
            .custom<AbortSignal>((value) => value instanceof AbortSignal)
            .optional(),
          workspaceId: uuidSchema,
        })
        .strict()
        .parse(input);
      return reconcileWorkspace(parsed.workspaceId, parsed.signal);
    },
    releaseLegalHold: (input: LegalHoldCommandInput) =>
      command('legal_hold_released', input),
  });
}

export { ZERO_HASH as CONTROL_LEDGER_ZERO_HASH };
