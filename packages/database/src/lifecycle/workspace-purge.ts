import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as hashSchema } from '../validation/persisted-primitives.js';

import type { DatabaseConfig } from '../config.js';
import { workspaceControlRecordHash } from './control-record.js';
import { retentionQuery as query } from './retention-support.js';
import {
  inRetentionTransaction,
  withWorkspaceDestructiveOperationLock,
} from './retention-transaction.js';
import {
  isRecoverablePurgeClaimError,
  isRecoverablePurgeCompletionError,
  releasePurgeCompletionClaimAfterFailure,
  releasePurgeJobClaimAfterFailure,
} from './workspace-purge-claim-release.js';

const uuidSchema = z.uuid();

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
  readonly options: Readonly<{ max: number }>;
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
  if (pool.options.max < 2)
    throw new RangeError(
      'Workspace purge coordination requires a database pool of at least 2 connections',
    );

  const transaction = async <T>(
    signal: AbortSignal | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => inRetentionTransaction(pool as Pool, options, signal, work);

  const platformQuery = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<QueryResult<Row>> =>
    transaction(signal, (client) => query<Row>(client, text, values, signal));

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

  const findDueStep = (signal?: AbortSignal) =>
    platformQuery<{ job_id: string; workspace_id: string }>(
      'select * from app.find_due_workspace_purge_step()',
      [],
      signal,
    );
  const findDueCompletion = (signal?: AbortSignal) =>
    platformQuery<{ job_id: string; workspace_id: string }>(
      'select * from app.find_due_workspace_purge_completion()',
      [],
      signal,
    );
  const findDuePurge = (signal?: AbortSignal) =>
    platformQuery<{ workspace_id: string }>(
      'select * from app.find_due_workspace_purge()',
      [],
      signal,
    );

  const processStep = async (
    signal?: AbortSignal,
  ): Promise<WorkspacePurgeProcessResult | undefined> => {
    const dueStep = await findDueStep(signal);
    const stepCandidate = dueStep.rows[0];
    if (stepCandidate === undefined) return undefined;
    {
      const stepJobId = uuidSchema.parse(stepCandidate.job_id);
      const stepWorkspaceId = uuidSchema.parse(stepCandidate.workspace_id);
      let stepClaim: PurgeStepClaim | undefined;
      try {
        stepClaim = await withWorkspaceDestructiveOperationLock(
          pool,
          stepWorkspaceId,
          signal,
          async () => {
            const preparedAnchor = await transaction(signal, (client) =>
              lockAnchor(client, stepWorkspaceId, signal),
            );
            const claimedStep = await transaction(signal, async (client) => {
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
            stepClaim = claimedStep;
            if (claimedStep?.stepName === 'object_versions') {
              const objectPage = objectPageSchema.parse(
                await objectStore.purgeWorkspacePage({
                  maxObjects: 500,
                  signal: operationSignal(signal),
                  workspaceId: stepWorkspaceId,
                }),
              );
              await transaction(signal, async (client) => {
                const anchor = await lockAnchor(
                  client,
                  stepWorkspaceId,
                  signal,
                );
                if (
                  anchor.sequence !== claimedStep.anchor.sequence ||
                  anchor.hash !== claimedStep.anchor.hash
                )
                  throw new Error('Workspace purge control fence changed');
                await query(
                  client,
                  `select app.checkpoint_workspace_object_versions_page(
                      $1,$2,$3,$4,$5,$6,$7
                    )`,
                  [
                    stepJobId,
                    claimedStep.leaseToken,
                    claimedStep.leaseFence,
                    objectPage.deletedCount,
                    objectPage.completed,
                    anchor.sequence,
                    anchor.hash,
                  ],
                  signal,
                );
              });
            }
            return claimedStep;
          },
        );
        if (stepClaim === undefined) return { status: 'idle' as const };
        return {
          jobId: stepJobId,
          status: 'progressed' as const,
          workspaceId: stepWorkspaceId,
        };
      } catch (error: unknown) {
        if (signal?.aborted === true) throw signal.reason;
        if (stepClaim !== undefined)
          await platformQuery(
            'select app.release_workspace_purge_step($1,$2,$3)',
            [stepJobId, stepClaim.leaseToken, stepClaim.leaseFence],
            signal,
          );
        if (isRecoverablePurgeCompletionError(error))
          return { status: 'idle' as const };
        throw error;
      }
    }
  };

  const processCompletion = async (
    signal?: AbortSignal,
  ): Promise<WorkspacePurgeProcessResult | undefined> => {
    const dueCompletion = await findDueCompletion(signal);
    const completionCandidate = dueCompletion.rows[0];
    if (completionCandidate === undefined) return undefined;
    {
      const completionJobId = uuidSchema.parse(completionCandidate.job_id);
      const completionWorkspaceId = uuidSchema.parse(
        completionCandidate.workspace_id,
      );
      let completion: PreparedCompletion | undefined;
      try {
        completion = await transaction(signal, async (client) => {
          const anchor = await lockAnchor(
            client,
            completionWorkspaceId,
            signal,
          );
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
        await withWorkspaceDestructiveOperationLock(
          pool,
          completionWorkspaceId,
          signal,
          () =>
            transaction(signal, async (client) => {
              const anchor = await lockAnchor(
                client,
                completionWorkspaceId,
                signal,
              );
              const leaseFence = sequence(preparedCompletion.lease_fence);
              await query(
                client,
                'select app.authorize_workspace_purge_completion_append($1,$2,$3,$4,$5)',
                [
                  completionJobId,
                  preparedCompletion.lease_token,
                  leaseFence,
                  anchor.sequence,
                  anchor.hash,
                ],
                signal,
              );
              const nextSequence = anchor.sequence + 1;
              await query(
                client,
                'select app.project_workspace_purge_completion($1,$2,$3,$4,$5,$6)',
                [
                  completionJobId,
                  preparedCompletion.lease_token,
                  leaseFence,
                  nextSequence,
                  anchor.hash,
                  workspaceControlRecordHash({
                    actorRef: preparedCompletion.actor_ref,
                    commandId: preparedCompletion.command_id,
                    commandType: 'deletion_completed',
                    occurredAt: preparedCompletion.occurred_at,
                    previousHash: anchor.hash,
                    reason: preparedCompletion.reason,
                    sequence: nextSequence,
                    workspaceId: completionWorkspaceId,
                  }),
                ],
                signal,
              );
            }),
        );
        return {
          jobId: completionJobId,
          status: 'completed' as const,
          workspaceId: completionWorkspaceId,
        };
      } catch (error: unknown) {
        if (signal?.aborted === true) throw signal.reason;
        if (completion === undefined) {
          if (isRecoverablePurgeCompletionError(error))
            return { status: 'idle' as const };
          throw error;
        }
        const released = await releasePurgeCompletionClaimAfterFailure(
          platformQuery,
          completionJobId,
          completion.lease_token,
          sequence(completion.lease_fence),
          error,
          signal,
        );
        if (!isRecoverablePurgeCompletionError(error)) throw error;
        return {
          jobId: completionJobId,
          status: released ? ('released' as const) : ('stale' as const),
          workspaceId: completionWorkspaceId,
        };
      }
    }
  };

  const processStart = async (
    signal?: AbortSignal,
  ): Promise<WorkspacePurgeProcessResult | undefined> => {
    const due = await findDuePurge(signal);
    const candidate = due.rows[0];
    if (candidate === undefined) return undefined;
    const workspaceId = uuidSchema.parse(candidate.workspace_id);
    let job: PreparedJob | undefined;

    try {
      job = await transaction(signal, async (client) => {
        const anchor = await lockAnchor(client, workspaceId, signal);
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

      await withWorkspaceDestructiveOperationLock(
        pool,
        workspaceId,
        signal,
        () =>
          transaction(signal, async (client) => {
            const anchor = await lockAnchor(client, workspaceId, signal);
            const nextSequence = anchor.sequence + 1;
            await query(
              client,
              'select app.project_workspace_purge_started($1,$2,$3,$4,$5,$6)',
              [
                preparedJob.job_id,
                preparedJob.lease_token,
                sequence(preparedJob.lease_fence),
                nextSequence,
                anchor.hash,
                workspaceControlRecordHash({
                  actorRef: preparedJob.actor_ref,
                  commandId: preparedJob.command_id,
                  commandType: 'purge_started',
                  occurredAt: preparedJob.occurred_at,
                  previousHash: anchor.hash,
                  reason: preparedJob.reason,
                  sequence: nextSequence,
                  workspaceId,
                }),
              ],
              signal,
            );
          }),
      );
      return {
        jobId: preparedJob.job_id,
        status: 'started' as const,
        workspaceId,
      };
    } catch (error: unknown) {
      if (signal?.aborted === true) throw signal.reason;
      if (job === undefined) {
        if (isRecoverablePurgeClaimError(error))
          return { status: 'idle' as const };
        throw error;
      }
      const released = await releasePurgeJobClaimAfterFailure(
        platformQuery,
        job.job_id,
        job.lease_token,
        sequence(job.lease_fence),
        error,
        signal,
      );
      if (!isRecoverablePurgeClaimError(error)) throw error;
      return {
        jobId: job.job_id,
        status: released ? ('released' as const) : ('stale' as const),
        workspaceId,
      };
    }
  };

  return Object.freeze({
    close: () => lease?.close() ?? Promise.resolve(),
    processNext: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return (
        (await processStep(signal)) ??
        (await processCompletion(signal)) ??
        (await processStart(signal)) ?? { status: 'idle' as const }
      );
    },
  });
}
