import { createDatabasePool } from '../platform/postgres-telemetry.js';
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as hashSchema } from '../validation/persisted-primitives.js';

import type { DatabaseConfig } from '../config.js';
import {
  acquirePoolClient,
  cancelBackendQuery,
  externalSignal,
  query,
  raceWithSignal,
  throwIfAborted,
  type MaintenancePool,
} from './control-ledger-postgres.js';
import {
  ControlLedgerCommandConflictError,
  ControlLedgerReconciliationBoundError,
  ControlLedgerReconciliationError,
} from './control-ledger-errors.js';
import {
  createControlLedgerReadSide,
  type CommittedArtifactInventoryInput,
  type CommittedArtifactInventoryPage,
} from './control-ledger-read-side.js';

const ZERO_HASH = '0'.repeat(64);
const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
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
    readonly repairCommandId?: string;
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

export interface ControlLedgerInventoryResult {
  readonly inventoryDigest: string;
  readonly projectedRecordCount: number;
  readonly sweepCount: number;
  readonly workspaceCount: number;
}

export interface ControlLedgerCoordinator {
  checkRestoreReadiness(input: {
    readonly expectedMaintenanceRole: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
  listCommittedArtifacts(
    input: CommittedArtifactInventoryInput,
  ): Promise<CommittedArtifactInventoryPage>;
  placeLegalHold(input: LegalHoldCommandInput): Promise<LegalHoldCommandResult>;
  reconcileWorkspace(input: {
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<ControlLedgerReconcileResult>;
  reconcileAllWorkspaces(input?: {
    readonly signal?: AbortSignal;
  }): Promise<ControlLedgerInventoryResult>;
  releaseLegalHold(
    input: LegalHoldCommandInput,
  ): Promise<LegalHoldCommandResult>;
}

export {
  ControlLedgerCommandConflictError,
  ControlLedgerReconciliationBoundError,
  ControlLedgerReconciliationError,
} from './control-ledger-errors.js';
export type {
  CommittedArtifactInventoryInput,
  CommittedArtifactInventoryPage,
  CommittedArtifactInventoryRecord,
} from './control-ledger-read-side.js';

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

interface ReconcileChunk {
  readonly highWater: HighWater;
  readonly reachedHighWater: boolean;
  readonly records: readonly ControlLedgerRecord[];
}

class ControlLedgerAnchorChangedError extends Error {}

const optionsSchema = z.object({
  externalOperationTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(120_000),
  lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  inventoryPageSize: z.number().int().min(1).max(100).default(100),
  maxInventoryPages: z.number().int().min(1).max(100_000).default(10_000),
  maxInventorySweeps: z.number().int().min(2).max(100).default(3),
  maxPages: z.number().int().min(1).max(1_000).default(10),
  maxRecords: z.number().int().min(1).max(1_000).default(1_000),
  maxWorkspaceReconcileAttempts: z.number().int().min(1).max(1_000).default(10),
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
    !z
      .enum([
        'legal_hold_placed',
        'legal_hold_released',
        'deletion_requested',
        'deletion_restored',
        'purge_started',
        'deletion_completed',
      ])
      .safeParse(record.commandType).success
  )
    throw new ControlLedgerReconciliationError(
      `Unsupported control ledger command: ${record.commandType}`,
    );
  const material = z.object({
    actorRef: boundedText(128),
    commandId: uuidSchema,
    occurredAt: occurredAtSchema,
    reason: boundedText(512),
    subjectId: uuidSchema,
  });
  material.parse(record);
  if (record.commandType.startsWith('legal_hold_'))
    boundedText(256).parse(record.legalAuthority);
  else if (record.legalAuthority !== undefined)
    throw new ControlLedgerReconciliationError(
      'Deletion control ledger record must omit legal authority',
    );
  if (
    !record.commandType.startsWith('legal_hold_') &&
    record.subjectId !== workspaceId
  )
    throw new ControlLedgerReconciliationError(
      'Deletion control ledger subject must be its workspace',
    );
}

async function project(
  client: PoolClient,
  record: ControlLedgerRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  const legalHold = record.commandType.startsWith('legal_hold_');
  const projection = legalHold
    ? 'app.project_workspace_legal_hold'
    : 'app.project_workspace_deletion';
  const result = await query<Record<string, boolean>>(
    client,
    `select ${projection}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) projected`,
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
  return result.rows[0]?.projected === true;
}

export function createControlLedgerCoordinator(
  config: DatabaseConfig,
  ledger: ControlLedger,
  options: Readonly<{
    externalOperationTimeoutMs?: number;
    inventoryPageSize?: number;
    lockTimeoutMs?: number;
    maxInventoryPages?: number;
    maxInventorySweeps?: number;
    maxPages?: number;
    maxRecords?: number;
    maxWorkspaceReconcileAttempts?: number;
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
  const pool = options.pool ?? createDatabasePool(config);
  const ownsPool = options.pool === undefined;
  const readSide = createControlLedgerReadSide(config, pool);

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
         set local statement_timeout='${String(parsedOptions.statementTimeoutMs)}ms'`,
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

  const fetchReconcileChunk = async (
    workspaceId: string,
    initial: HighWater,
    maximumRecords: number,
    signal?: AbortSignal,
    repairCommandId?: string,
  ): Promise<ReconcileChunk> => {
    let highWater = initial;
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
        ...(repairCommandId === undefined ? {} : { repairCommandId }),
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
      highWater = { hash: record.recordHash, sequence: record.sequence };
    }
    if (
      response.pageEndSequence !== highWater.sequence ||
      response.pageEndHash !== highWater.hash
    )
      throw new ControlLedgerReconciliationError(
        'External control ledger page high water is invalid',
      );
    return Object.freeze({
      highWater: Object.freeze(highWater),
      reachedHighWater: response.reachedHighWater,
      records: Object.freeze([...response.records]),
    });
  };

  const projectReconcileChunk = async (
    client: PoolClient,
    workspaceId: string,
    initial: HighWater,
    chunk: ReconcileChunk,
    signal?: AbortSignal,
  ): Promise<
    ControlLedgerReconcileResult & { readonly reachedHighWater: boolean }
  > => {
    let highWater = initial;
    for (const record of chunk.records) {
      await project(client, record, signal);
      highWater = { hash: record.recordHash, sequence: record.sequence };
    }
    return Object.freeze({
      highWaterHash: highWater.hash,
      highWaterSequence: highWater.sequence,
      projectedCount: chunk.records.length,
      reachedHighWater: chunk.reachedHighWater,
      workspaceId,
    });
  };

  const sameHighWater = (left: HighWater, right: HighWater): boolean =>
    left.sequence === right.sequence && left.hash === right.hash;

  const reconcileWorkspace = async (
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<ControlLedgerReconcileResult> => {
    let projectedCount = 0;
    let anchorAttempts = 0;
    for (let page = 0; page < parsedOptions.maxPages; page += 1) {
      const remaining = parsedOptions.maxRecords - projectedCount;
      if (remaining < 1) break;
      const initial = await transact(
        workspaceId,
        signal,
        (_client, highWater) => Promise.resolve(Object.freeze(highWater)),
      );
      const fetched = await fetchReconcileChunk(
        workspaceId,
        initial,
        remaining,
        signal,
      );
      const applied = await transact(
        workspaceId,
        signal,
        (client, highWater) => {
          if (!sameHighWater(highWater, initial))
            throw new ControlLedgerAnchorChangedError();
          return projectReconcileChunk(
            client,
            workspaceId,
            initial,
            fetched,
            signal,
          );
        },
      ).catch((error: unknown) => {
        if (error instanceof ControlLedgerAnchorChangedError) return undefined;
        throw error;
      });
      if (applied === undefined) {
        anchorAttempts += 1;
        if (anchorAttempts >= parsedOptions.maxWorkspaceReconcileAttempts)
          throw new ControlLedgerReconciliationBoundError();
        page -= 1;
        continue;
      }
      anchorAttempts = 0;
      projectedCount += applied.projectedCount;
      if (applied.reachedHighWater)
        return Object.freeze({
          highWaterHash: applied.highWaterHash,
          highWaterSequence: applied.highWaterSequence,
          projectedCount,
          workspaceId,
        });
    }
    throw new ControlLedgerReconciliationBoundError();
  };

  const enumerateAnchors = async (
    afterWorkspaceId: string | undefined,
    signal?: AbortSignal,
  ): Promise<readonly string[]> => {
    const client = await acquirePoolClient(pool, signal);
    try {
      const result = await query<{ workspace_id: string }>(
        client,
        'select workspace_id from app.enumerate_workspace_control_anchors($1,$2)',
        [afterWorkspaceId ?? null, parsedOptions.inventoryPageSize],
        signal,
      );
      const workspaceIds = result.rows.map((row) =>
        uuidSchema.parse(row.workspace_id),
      );
      let previous = afterWorkspaceId;
      for (const workspaceId of workspaceIds) {
        if (previous !== undefined && workspaceId <= previous)
          throw new ControlLedgerReconciliationError(
            'Workspace control anchor inventory is not strictly ordered',
          );
        previous = workspaceId;
      }
      return Object.freeze(workspaceIds);
    } finally {
      client.release();
    }
  };

  const reconcileSweep = async (
    signal?: AbortSignal,
  ): Promise<{
    readonly digest: string;
    readonly projectedRecordCount: number;
    readonly workspaceCount: number;
  }> => {
    const digest = createHash('sha256');
    let afterWorkspaceId: string | undefined;
    let projectedRecordCount = 0;
    let workspaceCount = 0;
    for (let page = 0; page < parsedOptions.maxInventoryPages; page += 1) {
      throwIfAborted(signal);
      const workspaceIds = await enumerateAnchors(afterWorkspaceId, signal);
      for (const workspaceId of workspaceIds) {
        let reconciled: ControlLedgerReconcileResult | undefined;
        for (
          let attempt = 0;
          attempt < parsedOptions.maxWorkspaceReconcileAttempts;
          attempt += 1
        ) {
          try {
            reconciled = await reconcileWorkspace(workspaceId, signal);
            break;
          } catch (error: unknown) {
            if (!(error instanceof ControlLedgerReconciliationBoundError))
              throw error;
          }
        }
        if (reconciled === undefined)
          throw new ControlLedgerReconciliationBoundError();
        digest.update(
          `${workspaceId}\0${String(reconciled.highWaterSequence)}\0${reconciled.highWaterHash}\n`,
        );
        projectedRecordCount += reconciled.projectedCount;
        workspaceCount += 1;
      }
      if (workspaceIds.length < parsedOptions.inventoryPageSize)
        return Object.freeze({
          digest: digest.digest('hex'),
          projectedRecordCount,
          workspaceCount,
        });
      afterWorkspaceId = workspaceIds.at(-1);
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
      const prepared = await transact(
        parsed.workspaceId,
        parsed.signal,
        async (client, initial) => {
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
              existing: Object.freeze({
                commandId: row.command_id,
                commandType,
                holdId: row.subject_id,
                recordHash: row.record_hash,
                replayed: true,
                sequence: numberSequence(row.sequence),
                workspaceId: parsed.workspaceId,
              }),
              initial: Object.freeze(initial),
            };
          }

          await query(
            client,
            'select app.validate_workspace_legal_hold_command($1,$2,$3)',
            [parsed.workspaceId, commandType, parsed.holdId],
            parsed.signal,
          );
          return {
            existing: undefined,
            initial: Object.freeze(initial),
          };
        },
      );
      if (prepared.existing !== undefined) return prepared.existing;

      const fetched = await fetchReconcileChunk(
        parsed.workspaceId,
        prepared.initial,
        remaining,
        parsed.signal,
        parsed.commandId,
      );
      const projected = await transact(
        parsed.workspaceId,
        parsed.signal,
        async (client, highWater) => {
          if (!sameHighWater(highWater, prepared.initial))
            throw new ControlLedgerAnchorChangedError();
          return projectReconcileChunk(
            client,
            parsed.workspaceId,
            prepared.initial,
            fetched,
            parsed.signal,
          );
        },
      ).catch((error: unknown) => {
        if (error instanceof ControlLedgerAnchorChangedError) return undefined;
        throw error;
      });
      if (projected === undefined) continue;
      projectedCount += projected.projectedCount;
      if (!projected.reachedHighWater) continue;

      const repaired = await transact(
        parsed.workspaceId,
        parsed.signal,
        async (client) => {
          const existing = await query<ProjectionRow>(
            client,
            'select * from app.read_workspace_control_command($1,$2)',
            [parsed.workspaceId, parsed.commandId],
            parsed.signal,
          );
          const row = existing.rows[0];
          if (row === undefined) {
            await query(
              client,
              'select app.validate_workspace_legal_hold_command($1,$2,$3)',
              [parsed.workspaceId, commandType, parsed.holdId],
              parsed.signal,
            );
            return undefined;
          }
          const rowOccurredAt = new Date(row.occurred_at).toISOString();
          if (
            row.command_type !== commandType ||
            row.subject_id !== parsed.holdId ||
            row.actor_ref !== parsed.actorRef ||
            row.legal_authority !== parsed.legalAuthority ||
            row.reason !== parsed.reason ||
            rowOccurredAt !== parsed.occurredAt
          )
            throw new ControlLedgerCommandConflictError();
          return Object.freeze({
            commandId: row.command_id,
            commandType,
            holdId: row.subject_id,
            recordHash: row.record_hash,
            replayed: true,
            sequence: numberSequence(row.sequence),
            workspaceId: parsed.workspaceId,
          });
        },
      );
      if (repaired !== undefined) return repaired;

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
        previousHash: projected.highWaterHash,
        reason: parsed.reason,
        sequence: projected.highWaterSequence + 1,
        signal: appendSignal,
        subjectId: parsed.holdId,
        workspaceId: parsed.workspaceId,
      };
      const appended = await raceWithSignal(
        ledger.append(appendInput),
        appendSignal,
      );
      assertRecord(appended, parsed.workspaceId, {
        hash: projected.highWaterHash,
        sequence: projected.highWaterSequence,
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

      const completed = await transact(
        parsed.workspaceId,
        parsed.signal,
        async (client, highWater) => {
          if (
            highWater.sequence !== appended.sequence - 1 ||
            highWater.hash !== appended.previousHash
          )
            return undefined;
          await query(
            client,
            'select app.validate_workspace_legal_hold_command($1,$2,$3)',
            [parsed.workspaceId, commandType, parsed.holdId],
            parsed.signal,
          );
          await project(client, appended, parsed.signal);
          return Object.freeze({
            commandId: appended.commandId,
            commandType,
            holdId: appended.subjectId,
            recordHash: appended.recordHash,
            replayed: false,
            sequence: appended.sequence,
            workspaceId: appended.workspaceId,
          });
        },
      );
      if (completed !== undefined) return completed;
    }
    throw new ControlLedgerReconciliationBoundError();
  };

  return Object.freeze({
    ...readSide,
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
    reconcileAllWorkspaces: async (input = {}) => {
      const parsedInput = z
        .object({
          signal: z
            .custom<AbortSignal>((value) => value instanceof AbortSignal)
            .optional(),
        })
        .strict()
        .parse(input);
      let previous: Awaited<ReturnType<typeof reconcileSweep>> | undefined;
      let projectedRecordCount = 0;
      for (
        let sweepCount = 1;
        sweepCount <= parsedOptions.maxInventorySweeps;
        sweepCount += 1
      ) {
        const current = await reconcileSweep(parsedInput.signal);
        projectedRecordCount += current.projectedRecordCount;
        if (
          current.digest === previous?.digest &&
          current.workspaceCount === previous.workspaceCount &&
          current.projectedRecordCount === 0
        )
          return Object.freeze({
            inventoryDigest: current.digest,
            projectedRecordCount,
            sweepCount,
            workspaceCount: current.workspaceCount,
          });
        previous = current;
      }
      throw new ControlLedgerReconciliationBoundError();
    },
    releaseLegalHold: (input: LegalHoldCommandInput) =>
      command('legal_hold_released', input),
  });
}

export { ZERO_HASH as CONTROL_LEDGER_ZERO_HASH };
