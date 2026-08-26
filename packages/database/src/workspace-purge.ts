import { Pool, type PoolClient, type QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';

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
    readonly commandType: 'purge_started';
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
  job: PreparedJob,
  workspaceId: string,
  previousHash: string,
  expectedSequence: number,
): void {
  if (
    record.actorRef !== job.actor_ref ||
    record.commandId !== job.command_id ||
    record.commandType !== 'purge_started' ||
    new Date(record.occurredAt).toISOString() !==
      new Date(job.occurred_at).toISOString() ||
    record.previousHash !== previousHash ||
    record.reason !== job.reason ||
    record.sequence !== expectedSequence ||
    record.subjectId !== workspaceId ||
    record.workspaceId !== workspaceId ||
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

export function createWorkspacePurgeCoordinator(
  config: DatabaseConfig,
  ledger: WorkspacePurgeLedger,
  objectStore: WorkspacePurgeObjectStore,
  inputOptions: WorkspacePurgeOptions,
): WorkspacePurgeCoordinator {
  const { pool: suppliedPool, ...rawOptions } = inputOptions;
  const options = optionsSchema.parse(rawOptions);
  const pool = suppliedPool ?? new Pool(config);
  const ownsPool = suppliedPool === undefined;

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
      await query(
        client,
        "select set_config('idle_in_transaction_session_timeout','0',true)",
        [],
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

  return Object.freeze({
    close: () => (ownsPool ? pool.end() : Promise.resolve()),
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
        try {
          const page = await transaction(signal, async (client) => {
            const locked = await query<{
              retention_control_hash: string;
              retention_control_sequence: number | string;
            }>(
              client,
              'select * from app.lock_workspace_control_ledger($1)',
              [stepWorkspaceId],
              signal,
            );
            const anchor = locked.rows[0];
            if (anchor === undefined)
              throw new Error(
                'Workspace purge step control lock was not returned',
              );
            const projectedSequence = sequence(
              anchor.retention_control_sequence,
            );
            const projectedHash = hashSchema.parse(
              anchor.retention_control_hash,
            );
            const operationSignal = AbortSignal.any([
              ...(signal === undefined ? [] : [signal]),
              AbortSignal.timeout(options.externalOperationTimeoutMs),
            ]);
            const reconciliation = await ledger.reconcile({
              maxRecords: 1,
              projectedHash,
              projectedSequence,
              signal: operationSignal,
              workspaceId: stepWorkspaceId,
            });
            if (
              !reconciliation.reachedHighWater ||
              reconciliation.hasMore ||
              reconciliation.records.length !== 0 ||
              reconciliation.pageEndSequence !== projectedSequence ||
              reconciliation.pageEndHash !== projectedHash
            )
              throw new Error(
                'Workspace purge step requires exact control ledger high water',
              );
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
                projectedSequence,
                projectedHash,
                options.leaseOwner,
                options.leaseSeconds,
              ],
              signal,
            );
            const claim = claimed.rows[0];
            if (claim === undefined) return undefined;
            const stepName = z
              .enum(['object_versions', 'tenant_rows'])
              .parse(claim.step_name);
            const leaseToken = uuidSchema.parse(claim.lease_token);
            const leaseFence = sequence(claim.lease_fence);
            if (stepName === 'object_versions') {
              const objectPage = objectPageSchema.parse(
                await objectStore.purgeWorkspacePage({
                  maxObjects: 500,
                  signal: operationSignal,
                  workspaceId: stepWorkspaceId,
                }),
              );
              await query(
                client,
                `select app.checkpoint_workspace_object_versions_page(
                  $1,$2,$3,$4,$5,$6,$7
                )`,
                [
                  stepJobId,
                  leaseToken,
                  leaseFence,
                  objectPage.deletedCount,
                  objectPage.completed,
                  projectedSequence,
                  projectedHash,
                ],
                signal,
              );
              return { completed: false };
            }
            await query(
              client,
              "select set_config('app.workspace_id',$1,true)",
              [stepWorkspaceId],
              signal,
            );
            const executed = await query<{
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
                projectedSequence,
                projectedHash,
              ],
              signal,
            );
            return executed.rows[0];
          });
          if (page === undefined) return { status: 'idle' as const };
          return {
            jobId: stepJobId,
            status: page.completed
              ? ('completed' as const)
              : ('progressed' as const),
            workspaceId: stepWorkspaceId,
          };
        } catch (error: unknown) {
          if (signal?.aborted === true) throw signal.reason;
          if (isLegalHold(error) || isClaimRace(error))
            return { status: 'idle' as const };
          throw error;
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
        job = await transaction(signal, async (client) => {
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
          const projectedSequence = sequence(anchor.retention_control_sequence);
          const projectedHash = hashSchema.parse(anchor.retention_control_hash);
          const repair = await query<{ command_id: string | null }>(
            client,
            'select app.workspace_purge_repair_command_id($1) command_id',
            [workspaceId],
            signal,
          );
          const repairCommandId =
            repair.rows[0]?.command_id === null ||
            repair.rows[0]?.command_id === undefined
              ? undefined
              : uuidSchema.parse(repair.rows[0].command_id);
          const operationSignal = AbortSignal.any([
            ...(signal === undefined ? [] : [signal]),
            AbortSignal.timeout(options.externalOperationTimeoutMs),
          ]);
          const reconciliation = await ledger.reconcile({
            maxRecords: 1,
            projectedHash,
            projectedSequence,
            ...(repairCommandId === undefined ? {} : { repairCommandId }),
            signal: operationSignal,
            workspaceId,
          });
          if (
            !reconciliation.reachedHighWater ||
            reconciliation.hasMore ||
            reconciliation.records.length >
              (repairCommandId === undefined ? 0 : 1) ||
            (reconciliation.records.length === 0 &&
              (reconciliation.pageEndSequence !== projectedSequence ||
                reconciliation.pageEndHash !== projectedHash))
          )
            throw new Error(
              'Workspace purge requires exact control ledger high water',
            );
          const prepared = await query<PreparedJob>(
            client,
            `select * from app.prepare_workspace_purge_job(
              $1,$2,$3,$4,make_interval(secs=>$5)
            )`,
            [
              workspaceId,
              projectedSequence,
              projectedHash,
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

        await transaction(signal, async (client) => {
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
          const projectedSequence = sequence(anchor.retention_control_sequence);
          const previousHash = hashSchema.parse(anchor.retention_control_hash);
          const operationSignal = AbortSignal.any([
            ...(signal === undefined ? [] : [signal]),
            AbortSignal.timeout(options.externalOperationTimeoutMs),
          ]);
          const reconciliation = await ledger.reconcile({
            maxRecords: 2,
            projectedHash: previousHash,
            projectedSequence,
            repairCommandId: preparedJob.command_id,
            signal: operationSignal,
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
          const expectedSequence = projectedSequence + 1;
          let record = reconciliation.records[0];
          record ??= await ledger.append({
            actorRef: preparedJob.actor_ref,
            commandId: preparedJob.command_id,
            commandType: 'purge_started',
            occurredAt: new Date(preparedJob.occurred_at).toISOString(),
            previousHash,
            reason: preparedJob.reason,
            sequence: expectedSequence,
            signal: operationSignal,
            subjectId: workspaceId,
            workspaceId,
          });
          verifyRecord(
            record,
            preparedJob,
            workspaceId,
            previousHash,
            expectedSequence,
          );
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
          if (isClaimRace(error)) return { status: 'idle' as const };
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
