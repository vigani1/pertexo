import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import type { PoolClient, QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';

const uuidSchema = z.uuid();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export interface WorkspacePurgeLedgerRecord {
  readonly actorRef: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly occurredAt: string;
  readonly previousHash: string;
  readonly reason: string;
  readonly recordHash: string;
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly subjectId: string;
  readonly workspaceId: string;
}

export interface WorkspacePurgeLedger {
  append(input: {
    readonly actorRef: string;
    readonly commandId: string;
    readonly commandType: 'deletion_completed' | 'purge_started';
    readonly occurredAt: string;
    readonly previousHash: string;
    readonly reason: string;
    readonly sequence: number;
    readonly signal?: AbortSignal;
    readonly subjectId: string;
    readonly workspaceId: string;
  }): Promise<WorkspacePurgeLedgerRecord>;
  reconcile(input: {
    readonly maxRecords: number;
    readonly projectedHash: string;
    readonly projectedSequence: number;
    readonly repairCommandId?: string;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<{
    readonly hasMore: boolean;
    readonly pageEndHash: string;
    readonly pageEndSequence: number;
    readonly reachedHighWater: boolean;
    readonly records: readonly WorkspacePurgeLedgerRecord[];
  }>;
}

export type WorkspacePurgeProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      jobId: string;
      status: 'completed' | 'progressed' | 'released' | 'stale' | 'started';
      workspaceId: string;
    }>;

export interface WorkspacePurgeCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<WorkspacePurgeProcessResult>;
}

export interface WorkspacePurgeObjectStore {
  purgeWorkspacePage(input: {
    readonly maxObjects: number;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<{
    readonly completed: boolean;
    readonly deletedCount: number;
  }>;
}

interface MaintenancePool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

const optionsSchema = z
  .object({
    externalOperationTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    leaseOwner: z.string().trim().min(1).max(128),
    leaseSeconds: z.number().int().min(1).max(300).default(300),
    lockTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
  })
  .refine(
    ({ externalOperationTimeoutMs, leaseSeconds, statementTimeoutMs }) =>
      externalOperationTimeoutMs + statementTimeoutMs < leaseSeconds * 1_000,
    { message: 'Purge timeout budget must be shorter than the lease' },
  );

type WorkspacePurgeOptions = z.input<typeof optionsSchema> & {
  readonly pool?: MaintenancePool;
};

const objectPageSchema = z
  .object({
    completed: z.boolean(),
    deletedCount: z.number().int().min(0).max(500),
  })
  .refine(
    ({ completed, deletedCount }) =>
      (completed && deletedCount === 0) || (!completed && deletedCount > 0),
    { message: 'Invalid workspace object purge page result' },
  );

function sequence(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Invalid workspace purge control sequence');
  return parsed;
}

function isClaimRace(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '55P03'
  );
}

function isLegalHold(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('active workspace legal hold')
  );
}

function isFenceChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('control fence changed') ||
      error.message.includes('projection fence changed'))
  );
}

async function query<Row extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  return client.query<Row>({
    text,
    values: [...values],
    ...(signal === undefined ? {} : { signal }),
  });
}

function verifyRecord(
  record: WorkspacePurgeLedgerRecord,
  expected: Readonly<{
    actorRef: string;
    commandId: string;
    commandType: 'deletion_completed' | 'purge_started';
    occurredAt: Date | string;
    previousHash: string;
    reason: string;
    sequence: number;
    workspaceId: string;
  }>,
): void {
  if (
    record.actorRef !== expected.actorRef ||
    record.commandId !== expected.commandId ||
    record.commandType !== expected.commandType ||
    new Date(record.occurredAt).toISOString() !==
      new Date(expected.occurredAt).toISOString() ||
    record.previousHash !== expected.previousHash ||
    record.reason !== expected.reason ||
    record.sequence !== expected.sequence ||
    record.subjectId !== expected.workspaceId ||
    record.workspaceId !== expected.workspaceId ||
    record.schemaVersion !== 1 ||
    !hashSchema.safeParse(record.recordHash).success
  )
    throw new Error('Purge ledger record conflicts with durable job');
}

interface PreparedJob extends Record<string, unknown> {
  actor_ref: string;
  command_id: string;
  job_id: string;
  lease_fence: number | string;
  lease_token: string;
  occurred_at: Date | string;
  reason: string;
}

interface PreparedCompletion extends Record<string, unknown> {
  actor_ref: string;
  command_id: string;
  lease_fence: number | string;
  lease_token: string;
  occurred_at: Date | string;
  reason: string;
}

interface PurgeAnchor {
  readonly hash: string;
  readonly sequence: number;
}

interface PurgeStepClaim {
  readonly anchor: PurgeAnchor;
  readonly leaseFence: number;
  readonly leaseToken: string;
  readonly stepName: 'object_versions' | 'tenant_rows';
}

export function createWorkspacePurgeCoordinator(
  config: DatabaseConfig,
  ledger: WorkspacePurgeLedger,
  objectStore: WorkspacePurgeObjectStore,
  inputOptions: WorkspacePurgeOptions,
  runtime?: DatabaseRuntime,
): WorkspacePurgeCoordinator {
  const { pool: suppliedPool, ...rawOptions } = inputOptions;
  const options = optionsSchema.parse(rawOptions);
  if (suppliedPool !== undefined && runtime !== undefined)
    throw new TypeError('Workspace purge database ownership is ambiguous');
  const lease =
    suppliedPool === undefined
      ? acquireDatabasePool(config, runtime, { role: 'maintenance' })
      : undefined;
  const pool = suppliedPool ?? lease?.pool;
  if (pool === undefined)
    throw new Error('Workspace purge database pool was not initialized');

  const transaction = async <T>(
    signal: AbortSignal | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await query(client, 'begin', [], signal);
      await query(
        client,
        "select set_config('lock_timeout',$1,true)",
        [`${String(options.lockTimeoutMs)}ms`],
        signal,
      );
      await query(
        client,
        "select set_config('statement_timeout',$1,true)",
        [`${String(options.statementTimeoutMs)}ms`],
        signal,
      );
      const result = await work(client);
      await query(client, 'commit', [], signal);
      return result;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const lockAnchor = async (
    client: PoolClient,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<PurgeAnchor> => {
    const locked = await query<{
      retention_control_hash: string;
      retention_control_sequence: number | string;
    }>(
      client,
      'select * from app.lock_workspace_control_ledger($1)',
      [workspaceId],
      signal,
    );
    const anchor = locked.rows[0];
    if (anchor === undefined)
      throw new Error('Workspace purge control lock was not returned');
    return Object.freeze({
      hash: hashSchema.parse(anchor.retention_control_hash),
      sequence: sequence(anchor.retention_control_sequence),
    });
  };

  const operationSignal = (signal?: AbortSignal): AbortSignal =>
    AbortSignal.any([
      ...(signal === undefined ? [] : [signal]),
      AbortSignal.timeout(options.externalOperationTimeoutMs),
    ]);

  const assertExactHighWater = async (
    workspaceId: string,
    anchor: PurgeAnchor,
    signal?: AbortSignal,
  ): Promise<void> => {
    const reconciliation = await ledger.reconcile({
      maxRecords: 1,
      projectedHash: anchor.hash,
      projectedSequence: anchor.sequence,
      signal: operationSignal(signal),
      workspaceId,
    });
    if (
      !reconciliation.reachedHighWater ||
      reconciliation.hasMore ||
      reconciliation.records.length !== 0 ||
      reconciliation.pageEndSequence !== anchor.sequence ||
      reconciliation.pageEndHash !== anchor.hash
    )
      throw new Error(
        'Workspace purge step requires exact control ledger high water',
      );
  };

  return Object.freeze({
    close: () => lease?.close() ?? Promise.resolve(),
    processNext: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const dueStep = await pool.query<{
        job_id: string;
        workspace_id: string;
      }>('select * from app.find_due_workspace_purge_step()');
      const stepCandidate = dueStep.rows[0];
      if (stepCandidate !== undefined) {
        const stepJobId = uuidSchema.parse(stepCandidate.job_id);
        const stepWorkspaceId = uuidSchema.parse(stepCandidate.workspace_id);
        let stepClaim: PurgeStepClaim | undefined;
        try {
          const preparedAnchor = await transaction(signal, (client) =>
            lockAnchor(client, stepWorkspaceId, signal),
          );
          await assertExactHighWater(stepWorkspaceId, preparedAnchor, signal);
          stepClaim = await transaction(signal, async (client) => {
            const anchor = await lockAnchor(client, stepWorkspaceId, signal);
            if (
              anchor.sequence !== preparedAnchor.sequence ||
              anchor.hash !== preparedAnchor.hash
            )
              return undefined;
            const claimed = await query<{
              lease_fence: number | string;
              lease_token: string;
              step_name: string;
            }>(
              client,
              `select * from app.claim_workspace_purge_step(
                $1,$2,$3,$4,make_interval(secs=>$5)
              )`,
              [
                stepJobId,
                anchor.sequence,
                anchor.hash,
                options.leaseOwner,
                options.leaseSeconds,
              ],
              signal,
            );
            const row = claimed.rows[0];
            if (row === undefined) return undefined;
            const stepName = z
              .enum(['object_versions', 'tenant_rows'])
              .parse(row.step_name);
            const leaseToken = uuidSchema.parse(row.lease_token);
            const leaseFence = sequence(row.lease_fence);
            if (stepName === 'object_versions')
              return Object.freeze({
                anchor,
                leaseFence,
                leaseToken,
                stepName,
              } satisfies PurgeStepClaim);
            await query(
              client,
              "select set_config('app.workspace_id',$1,true)",
              [stepWorkspaceId],
              signal,
            );
            await query<{
              affected_count: number | string;
              completed: boolean;
              surface: string;
            }>(
              client,
              `select * from app.execute_workspace_tenant_rows_page(
                $1,$2,$3,$4,$5,$6
              )`,
              [
                stepJobId,
                leaseToken,
                leaseFence,
                500,
                anchor.sequence,
                anchor.hash,
              ],
              signal,
            );
            return Object.freeze({
              anchor,
              leaseFence,
              leaseToken,
              stepName,
            } satisfies PurgeStepClaim);
          });
          if (stepClaim === undefined) return { status: 'idle' as const };
          if (stepClaim.stepName === 'object_versions') {
            const objectPage = objectPageSchema.parse(
              await objectStore.purgeWorkspacePage({
                maxObjects: 500,
                signal: operationSignal(signal),
                workspaceId: stepWorkspaceId,
              }),
            );
            await transaction(signal, async (client) => {
              const anchor = await lockAnchor(client, stepWorkspaceId, signal);
              if (
                anchor.sequence !== stepClaim?.anchor.sequence ||
                anchor.hash !== stepClaim.anchor.hash
              )
                throw new Error('Workspace purge control fence changed');
              await query(
                client,
                `select app.checkpoint_workspace_object_versions_page(
                  $1,$2,$3,$4,$5,$6,$7
                )`,
                [
                  stepJobId,
                  stepClaim.leaseToken,
                  stepClaim.leaseFence,
                  objectPage.deletedCount,
                  objectPage.completed,
                  anchor.sequence,
                  anchor.hash,
                ],
                signal,
              );
            });
          }
          return {
            jobId: stepJobId,
            status: 'progressed' as const,
            workspaceId: stepWorkspaceId,
          };
        } catch (error: unknown) {
          if (signal?.aborted === true) throw signal.reason;
          if (stepClaim !== undefined)
            await pool.query(
              'select app.release_workspace_purge_step($1,$2,$3)',
              [stepJobId, stepClaim.leaseToken, stepClaim.leaseFence],
            );
          if (isLegalHold(error) || isClaimRace(error) || isFenceChanged(error))
            return { status: 'idle' as const };
          throw error;
        }
      }
      const dueCompletion = await pool.query<{
        job_id: string;
        workspace_id: string;
      }>('select * from app.find_due_workspace_purge_completion()');
      const completionCandidate = dueCompletion.rows[0];
      if (completionCandidate !== undefined) {
        const completionJobId = uuidSchema.parse(completionCandidate.job_id);
        const completionWorkspaceId = uuidSchema.parse(
          completionCandidate.workspace_id,
        );
        let completion: PreparedCompletion | undefined;
        try {
          const candidate = await transaction(signal, async (client) => {
            const anchor = await lockAnchor(
              client,
              completionWorkspaceId,
              signal,
            );
            const repair = await query<{ command_id: string | null }>(
              client,
              'select app.workspace_purge_completion_repair_command_id($1) command_id',
              [completionWorkspaceId],
              signal,
            );
            return Object.freeze({
              anchor,
              repairCommandId:
                repair.rows[0]?.command_id === null ||
                repair.rows[0]?.command_id === undefined
                  ? undefined
                  : uuidSchema.parse(repair.rows[0].command_id),
            });
          });
          const candidateReconciliation = await ledger.reconcile({
            maxRecords: 1,
            projectedHash: candidate.anchor.hash,
            projectedSequence: candidate.anchor.sequence,
            ...(candidate.repairCommandId === undefined
              ? {}
              : { repairCommandId: candidate.repairCommandId }),
            signal: operationSignal(signal),
            workspaceId: completionWorkspaceId,
          });
          if (
            !candidateReconciliation.reachedHighWater ||
            candidateReconciliation.hasMore ||
            candidateReconciliation.records.length >
              (candidate.repairCommandId === undefined ? 0 : 1) ||
            (candidateReconciliation.records.length === 0 &&
              (candidateReconciliation.pageEndSequence !==
                candidate.anchor.sequence ||
                candidateReconciliation.pageEndHash !== candidate.anchor.hash))
          )
            throw new Error(
              'Workspace purge completion requires exact control ledger high water',
            );
          completion = await transaction(signal, async (client) => {
            const anchor = await lockAnchor(
              client,
              completionWorkspaceId,
              signal,
            );
            if (
              anchor.sequence !== candidate.anchor.sequence ||
              anchor.hash !== candidate.anchor.hash
            )
              throw new Error('Workspace purge completion fence changed');
            const prepared = await query<PreparedCompletion>(
              client,
              `select * from app.prepare_workspace_purge_completion(
                $1,$2,$3,$4,make_interval(secs=>$5)
              )`,
              [
                completionJobId,
                anchor.sequence,
                anchor.hash,
                options.leaseOwner,
                options.leaseSeconds,
              ],
              signal,
            );
            const value = prepared.rows[0];
            if (value === undefined)
              throw new Error('Workspace purge completion was not prepared');
            return value;
          });
          const preparedCompletion = completion;
          const appendAnchor = await transaction(signal, async (client) => {
            const anchor = await lockAnchor(
              client,
              completionWorkspaceId,
              signal,
            );
            await query(
              client,
              'select app.authorize_workspace_purge_completion_append($1,$2,$3,$4,$5)',
              [
                completionJobId,
                preparedCompletion.lease_token,
                sequence(preparedCompletion.lease_fence),
                anchor.sequence,
                anchor.hash,
              ],
              signal,
            );
            return anchor;
          });
          const reconciliation = await ledger.reconcile({
            maxRecords: 2,
            projectedHash: appendAnchor.hash,
            projectedSequence: appendAnchor.sequence,
            repairCommandId: preparedCompletion.command_id,
            signal: operationSignal(signal),
            workspaceId: completionWorkspaceId,
          });
          if (
            !reconciliation.reachedHighWater ||
            reconciliation.hasMore ||
            reconciliation.records.length > 1
          )
            throw new Error(
              'Workspace purge completion ledger has unrelated unprojected commands',
            );
          const expectedSequence = appendAnchor.sequence + 1;
          let record = reconciliation.records[0];
          record ??= await ledger.append({
            actorRef: preparedCompletion.actor_ref,
            commandId: preparedCompletion.command_id,
            commandType: 'deletion_completed',
            occurredAt: new Date(preparedCompletion.occurred_at).toISOString(),
            previousHash: appendAnchor.hash,
            reason: preparedCompletion.reason,
            sequence: expectedSequence,
            signal: operationSignal(signal),
            subjectId: completionWorkspaceId,
            workspaceId: completionWorkspaceId,
          });
          verifyRecord(record, {
            actorRef: preparedCompletion.actor_ref,
            commandId: preparedCompletion.command_id,
            commandType: 'deletion_completed',
            occurredAt: preparedCompletion.occurred_at,
            previousHash: appendAnchor.hash,
            reason: preparedCompletion.reason,
            sequence: expectedSequence,
            workspaceId: completionWorkspaceId,
          });
          await transaction(signal, async (client) => {
            const anchor = await lockAnchor(
              client,
              completionWorkspaceId,
              signal,
            );
            if (
              anchor.sequence !== appendAnchor.sequence ||
              anchor.hash !== appendAnchor.hash
            )
              throw new Error(
                'Workspace purge completion projection fence changed',
              );
            await query(
              client,
              'select app.project_workspace_purge_completion($1,$2,$3,$4,$5,$6)',
              [
                completionJobId,
                preparedCompletion.lease_token,
                sequence(preparedCompletion.lease_fence),
                record.sequence,
                record.previousHash,
                record.recordHash,
              ],
              signal,
            );
          });
          return {
            jobId: completionJobId,
            status: 'completed' as const,
            workspaceId: completionWorkspaceId,
          };
        } catch (error: unknown) {
          if (signal?.aborted === true) throw signal.reason;
          if (completion === undefined) {
            if (
              isLegalHold(error) ||
              isClaimRace(error) ||
              isFenceChanged(error)
            )
              return { status: 'idle' as const };
            throw error;
          }
          const released = await pool.query<{ changed: boolean }>(
            'select app.release_workspace_purge_completion($1,$2,$3) changed',
            [
              completionJobId,
              completion.lease_token,
              sequence(completion.lease_fence),
            ],
          );
          return {
            jobId: completionJobId,
            status:
              released.rows[0]?.changed === true
                ? ('released' as const)
                : ('stale' as const),
            workspaceId: completionWorkspaceId,
          };
        }
      }
      const due = await pool.query<{ workspace_id: string }>(
        'select * from app.find_due_workspace_purge()',
      );
      const candidate = due.rows[0];
      if (candidate === undefined) return { status: 'idle' as const };
      const workspaceId = uuidSchema.parse(candidate.workspace_id);
      let job: PreparedJob | undefined;

      try {
        const candidate = await transaction(signal, async (client) => {
          const anchor = await lockAnchor(client, workspaceId, signal);
          const repair = await query<{ command_id: string | null }>(
            client,
            'select app.workspace_purge_repair_command_id($1) command_id',
            [workspaceId],
            signal,
          );
          return Object.freeze({
            anchor,
            repairCommandId:
              repair.rows[0]?.command_id === null ||
              repair.rows[0]?.command_id === undefined
                ? undefined
                : uuidSchema.parse(repair.rows[0].command_id),
          });
        });
        const candidateReconciliation = await ledger.reconcile({
          maxRecords: 1,
          projectedHash: candidate.anchor.hash,
          projectedSequence: candidate.anchor.sequence,
          ...(candidate.repairCommandId === undefined
            ? {}
            : { repairCommandId: candidate.repairCommandId }),
          signal: operationSignal(signal),
          workspaceId,
        });
        if (
          !candidateReconciliation.reachedHighWater ||
          candidateReconciliation.hasMore ||
          candidateReconciliation.records.length >
            (candidate.repairCommandId === undefined ? 0 : 1) ||
          (candidateReconciliation.records.length === 0 &&
            (candidateReconciliation.pageEndSequence !==
              candidate.anchor.sequence ||
              candidateReconciliation.pageEndHash !== candidate.anchor.hash))
        )
          throw new Error(
            'Workspace purge requires exact control ledger high water',
          );
        job = await transaction(signal, async (client) => {
          const anchor = await lockAnchor(client, workspaceId, signal);
          if (
            anchor.sequence !== candidate.anchor.sequence ||
            anchor.hash !== candidate.anchor.hash
          )
            throw new Error('Workspace purge control fence changed');
          const prepared = await query<PreparedJob>(
            client,
            `select * from app.prepare_workspace_purge_job(
              $1,$2,$3,$4,make_interval(secs=>$5)
            )`,
            [
              workspaceId,
              anchor.sequence,
              anchor.hash,
              options.leaseOwner,
              options.leaseSeconds,
            ],
            signal,
          );
          const value = prepared.rows[0];
          if (value === undefined)
            throw new Error('Workspace purge job was not prepared');
          return value;
        });
        const preparedJob = job;

        const appendAnchor = await transaction(signal, (client) =>
          lockAnchor(client, workspaceId, signal),
        );
        const reconciliation = await ledger.reconcile({
          maxRecords: 2,
          projectedHash: appendAnchor.hash,
          projectedSequence: appendAnchor.sequence,
          repairCommandId: preparedJob.command_id,
          signal: operationSignal(signal),
          workspaceId,
        });
        if (
          !reconciliation.reachedHighWater ||
          reconciliation.hasMore ||
          reconciliation.records.length > 1
        )
          throw new Error(
            'Workspace purge ledger has unrelated unprojected commands',
          );
        const expectedSequence = appendAnchor.sequence + 1;
        let record = reconciliation.records[0];
        record ??= await ledger.append({
          actorRef: preparedJob.actor_ref,
          commandId: preparedJob.command_id,
          commandType: 'purge_started',
          occurredAt: new Date(preparedJob.occurred_at).toISOString(),
          previousHash: appendAnchor.hash,
          reason: preparedJob.reason,
          sequence: expectedSequence,
          signal: operationSignal(signal),
          subjectId: workspaceId,
          workspaceId,
        });
        verifyRecord(record, {
          actorRef: preparedJob.actor_ref,
          commandId: preparedJob.command_id,
          commandType: 'purge_started',
          occurredAt: preparedJob.occurred_at,
          previousHash: appendAnchor.hash,
          reason: preparedJob.reason,
          sequence: expectedSequence,
          workspaceId,
        });
        await transaction(signal, async (client) => {
          const anchor = await lockAnchor(client, workspaceId, signal);
          if (
            anchor.sequence !== appendAnchor.sequence ||
            anchor.hash !== appendAnchor.hash
          )
            throw new Error('Workspace purge projection fence changed');
          await query(
            client,
            'select app.project_workspace_purge_started($1,$2,$3,$4,$5,$6)',
            [
              preparedJob.job_id,
              preparedJob.lease_token,
              sequence(preparedJob.lease_fence),
              record.sequence,
              record.previousHash,
              record.recordHash,
            ],
            signal,
          );
        });
        return {
          jobId: preparedJob.job_id,
          status: 'started' as const,
          workspaceId,
        };
      } catch (error: unknown) {
        if (signal?.aborted === true) throw signal.reason;
        if (job === undefined) {
          if (isClaimRace(error) || isFenceChanged(error))
            return { status: 'idle' as const };
          throw error;
        }
        const released = await pool.query<{ changed: boolean }>(
          'select app.release_workspace_purge_job($1,$2,$3) changed',
          [job.job_id, job.lease_token, sequence(job.lease_fence)],
        );
        return {
          jobId: job.job_id,
          status:
            released.rows[0]?.changed === true
              ? ('released' as const)
              : ('stale' as const),
          workspaceId,
        };
      }
    },
  });
}
