import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalOutboxPayloadChecksum } from '../outbox/events.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from './workflow-authoring-errors.js';

const revision = z.number().int().min(1).max(2_147_483_647);
const limit = z.number().int().min(1).max(10_000).nullable();
const settings = z
  .object({
    asOf: z.iso.datetime({ precision: 6 }),
    limit,
    revision,
    workspaceActiveRunLimit: limit,
    workspacePolicyState: z.enum([
      'active',
      'suspended',
      'not_yet_effective',
      'expired',
      'unavailable',
    ]),
    overflow: z.literal('queue'),
  })
  .strict();
export type WorkflowConcurrencySettings = z.infer<typeof settings>;
type Scope = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export interface WorkflowConcurrencyDatabase {
  readSettings(input: Scope): Promise<WorkflowConcurrencySettings>;
  updateSettings(
    input: Scope &
      Readonly<{
        limit: number | null;
        expectedRevision: number;
        idempotencyKey: string;
        requestId?: string;
        traceId?: string;
      }>,
  ): Promise<
    Readonly<{ settings: WorkflowConcurrencySettings; replayed: boolean }>
  >;
}
export class WorkflowConcurrencyRevisionConflictError extends Error {
  public override readonly name = 'WorkflowConcurrencyRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workflow concurrency revision does not match');
  }
}
export class WorkflowConcurrencyLimitUnavailableError extends Error {
  public override readonly name = 'WorkflowConcurrencyLimitUnavailableError';
  public constructor() {
    super('Active workspace entitlement required');
  }
}
export class WorkflowConcurrencyLimitExceededError extends Error {
  public override readonly name = 'WorkflowConcurrencyLimitExceededError';
  public constructor(public readonly maximum: number) {
    super('Workflow concurrency limit exceeds workspace capacity');
  }
}
type Transact = <T>(
  workspaceId: string,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;
/** Shares the authoring factory's tracked transactions, cancellation and close. */
export function createWorkflowConcurrencyStore(
  transact: Transact,
): WorkflowConcurrencyDatabase {
  async function call(
    input: Scope,
    operation: 'read' | 'update',
    request: Record<string, unknown>,
    command?: { idempotencyKey: string; requestId?: string; traceId?: string },
  ) {
    const workspaceId = z.uuid().parse(input.workspaceId),
      actorId = z.uuid().parse(input.actorId),
      workflowId = z.uuid().parse(input.workflowId);
    const key =
      command === undefined
        ? null
        : z
            .string()
            .min(1)
            .max(128)
            .regex(/^[\x21-\x7e]+$/u)
            .refine((value) => !value.includes(','))
            .parse(command.idempotencyKey);
    return transact(
      workspaceId,
      actorId,
      async (client) => {
        try {
          const result = await client.query<{ result: unknown }>(
            'select app.workflow_concurrency_control($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) as result',
            [
              workspaceId,
              actorId,
              workflowId,
              operation,
              JSON.stringify(request),
              key === null
                ? null
                : createHash('sha256').update(key).digest('hex'),
              key === null
                ? null
                : canonicalOutboxPayloadChecksum({
                    workspaceId,
                    actorId,
                    workflowId,
                    operation,
                    ...request,
                  }),
              z.string().max(128).optional().parse(command?.requestId) ?? null,
              z.string().max(128).optional().parse(command?.traceId) ?? null,
            ],
          );
          return result.rows[0]?.result;
        } catch (error: unknown) {
          const parsed = z
            .object({ code: z.string(), detail: z.string().optional() })
            .loose()
            .safeParse(error);
          if (parsed.success) {
            const { code, detail } = parsed.data;
            if (code === 'PT404')
              throw new WorkflowNotFoundError(
                'Concurrency settings are not visible',
              );
            if (code === 'PT409')
              throw new WorkflowIdempotencyConflictError(
                'Concurrency idempotency key was reused',
              );
            if (code === 'PTC09')
              throw new WorkflowConcurrencyRevisionConflictError(
                revision.parse(Number(detail)),
              );
            if (code === 'PTC10')
              throw new WorkflowConcurrencyLimitUnavailableError();
            if (code === 'PTC11')
              throw new WorkflowConcurrencyLimitExceededError(
                z.number().int().positive().parse(Number(detail)),
              );
          }
          throw error;
        }
      },
      input.signal,
    );
  }
  return Object.freeze({
    readSettings: async (input) =>
      settings.parse(await call(input, 'read', {})),
    updateSettings: async (input) =>
      z
        .object({ settings, replayed: z.boolean() })
        .strict()
        .parse(
          await call(
            input,
            'update',
            {
              limit: limit.parse(input.limit),
              expectedRevision: revision.parse(input.expectedRevision),
            },
            input,
          ),
        ),
  } satisfies WorkflowConcurrencyDatabase);
}
