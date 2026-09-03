import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  PreviewDeliveryMismatchError,
  type PreviewDelivery,
} from './preview-execution.js';
import { withTenantScopedClient } from './tenant-access/workspace.js';

const previewCleanupConsumerName = 'preview-retention-cleaner';
const traceparentSchema = z
  .string()
  .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u);
const cleanupPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    previewRunId: z.uuid(),
    traceparent: traceparentSchema.optional(),
  })
  .strict();

export type PreviewCleanupArtifact = Readonly<{
  artifactId: string;
  workspaceId: string;
}>;

export type PreviewCleanupClaimResult =
  | Readonly<{ kind: 'claimed'; artifacts: readonly PreviewCleanupArtifact[] }>
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{ kind: 'rescheduled'; cleanupOutboxEventId: string }>;

export type PreviewCleanupFinishResult = Readonly<{
  kind: 'completed' | 'continued';
  cleanupOutboxEventId?: string;
}>;

export class PreviewCleanupStateError extends Error {
  public override readonly name = 'PreviewCleanupStateError';
  public constructor(readonly code: string) {
    super(`Preview cleanup cannot continue: ${code}`);
  }
}

async function validateDelivery(
  client: PoolClient,
  input: Readonly<{
    delivery: PreviewDelivery;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<z.output<typeof cleanupPayloadSchema>> {
  const result = await client.query<{
    aggregate_id: string;
    aggregate_type: string;
    job_name: string;
    payload: unknown;
    payload_checksum: string;
    schema_version: number;
  }>(
    `select aggregate_id,aggregate_type,job_name,payload,
            payload_checksum,schema_version
       from app.outbox_events
      where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.delivery.outboxEventId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new PreviewCleanupStateError('delivery_not_found');
  let payload: z.output<typeof cleanupPayloadSchema>;
  let checksum: string;
  try {
    payload = cleanupPayloadSchema.parse(row.payload);
    checksum = canonicalOutboxPayloadChecksum(payload);
  } catch {
    throw new PreviewDeliveryMismatchError();
  }
  if (
    row.aggregate_id !== input.previewRunId ||
    row.aggregate_type !== 'preview-run' ||
    row.job_name !== 'sweep-expired-previews' ||
    row.schema_version !== 1 ||
    row.payload_checksum !== input.delivery.payloadChecksum ||
    checksum !== row.payload_checksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.previewRunId !== input.previewRunId ||
    payload.outboxEventId !== input.delivery.outboxEventId
  )
    throw new PreviewDeliveryMismatchError();
  return payload;
}

async function claimReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<'completed' | 'open'> {
  const inserted = await client.query(
    `insert into app.inbox_receipts (
       consumer_name,message_id,workspace_id,payload_checksum
     ) values ($1,$2,$3,$4)
     on conflict (consumer_name,message_id) do nothing
     returning message_id`,
    [
      previewCleanupConsumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (inserted.rowCount === 1) return 'open';
  const existing = await client.query<{
    completed_at: Date | null;
    payload_checksum: string;
    workspace_id: string;
  }>(
    `select workspace_id,payload_checksum,completed_at
       from app.inbox_receipts
      where consumer_name=$1 and message_id=$2
      for update`,
    [previewCleanupConsumerName, delivery.outboxEventId],
  );
  const receipt = existing.rows[0];
  if (receipt === undefined)
    throw new PreviewCleanupStateError('receipt_missing');
  if (
    receipt.workspace_id !== workspaceId ||
    receipt.payload_checksum !== delivery.payloadChecksum
  )
    throw new PreviewDeliveryMismatchError();
  return receipt.completed_at === null ? 'open' : 'completed';
}

async function completeReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<void> {
  const completed = await client.query(
    `update app.inbox_receipts set completed_at=clock_timestamp()
      where consumer_name=$1 and message_id=$2 and workspace_id=$3
        and payload_checksum=$4 and completed_at is null`,
    [
      previewCleanupConsumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (completed.rowCount !== 1)
    throw new PreviewCleanupStateError('receipt_completion_lost');
}

async function insertCleanupDelivery(
  client: PoolClient,
  input: Readonly<{
    availableAt?: Date;
    previewRunId: string;
    traceparent?: string;
    workspaceId: string;
  }>,
): Promise<string> {
  const outboxEventId = uuidv7();
  const payload = cleanupPayloadSchema.parse({
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    outboxEventId,
    previewRunId: input.previewRunId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  });
  const inserted = await client.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
       payload,payload_checksum,available_at
     ) values (
       $1,$2,'sweep-expired-previews',1,'preview-run',$3,$4::jsonb,$5,
       coalesce($6::timestamptz,clock_timestamp())
     )`,
    [
      outboxEventId,
      input.workspaceId,
      input.previewRunId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
      input.availableAt ?? null,
    ],
  );
  if (inserted.rowCount !== 1)
    throw new PreviewCleanupStateError('cleanup_schedule_lost');
  return outboxEventId;
}

export async function claimPreviewCleanupDelivery(
  pool: Pool,
  input: Readonly<{
    artifactLimit: number;
    artifactQuiescenceSeconds?: number;
    delivery: PreviewDelivery;
    previewRunId: string;
    signal?: AbortSignal;
    workspaceId: string;
  }>,
): Promise<PreviewCleanupClaimResult> {
  const parsed = z
    .object({
      artifactLimit: z.number().int().min(1).max(100),
      artifactQuiescenceSeconds: z.number().int().min(1).max(120).default(60),
      previewRunId: z.uuid(),
      workspaceId: z.uuid(),
    })
    .parse(input);
  return withTenantScopedClient(
    pool,
    { workspaceId: parsed.workspaceId },
    async (client) => {
      const payload = await validateDelivery(client, {
        delivery: input.delivery,
        previewRunId: parsed.previewRunId,
        workspaceId: parsed.workspaceId,
      });
      if (
        (await claimReceipt(client, parsed.workspaceId, input.delivery)) ===
        'completed'
      )
        return Object.freeze({ kind: 'duplicate' });
      const run = await client.query<{
        due: boolean;
        expires_at: Date;
        status: string;
      }>(
        `select expires_at,status,expires_at <= clock_timestamp() as due
           from app.preview_runs
          where workspace_id=$1 and id=$2
          for update`,
        [parsed.workspaceId, parsed.previewRunId],
      );
      const state = run.rows[0];
      if (state === undefined) {
        await completeReceipt(client, parsed.workspaceId, input.delivery);
        return Object.freeze({ kind: 'duplicate' });
      }
      if (!state.due) {
        const successor = await insertCleanupDelivery(client, {
          availableAt: state.expires_at,
          previewRunId: parsed.previewRunId,
          ...(payload.traceparent === undefined
            ? {}
            : { traceparent: payload.traceparent }),
          workspaceId: parsed.workspaceId,
        });
        await completeReceipt(client, parsed.workspaceId, input.delivery);
        return Object.freeze({
          kind: 'rescheduled',
          cleanupOutboxEventId: successor,
        });
      }
      if (
        ![
          'succeeded',
          'failed',
          'canceled',
          'timed_out',
          'outcome_unknown',
        ].includes(state.status)
      ) {
        const retry = await client.query<{ retry_at: Date }>(
          `select clock_timestamp() + interval '1 minute' as retry_at`,
        );
        const retryAt = retry.rows[0]?.retry_at;
        if (retryAt === undefined)
          throw new PreviewCleanupStateError('database_clock_missing');
        const successor = await insertCleanupDelivery(client, {
          availableAt: retryAt,
          previewRunId: parsed.previewRunId,
          ...(payload.traceparent === undefined
            ? {}
            : { traceparent: payload.traceparent }),
          workspaceId: parsed.workspaceId,
        });
        await completeReceipt(client, parsed.workspaceId, input.delivery);
        return Object.freeze({
          kind: 'rescheduled',
          cleanupOutboxEventId: successor,
        });
      }
      const child = await client.query<{ retry_at: Date }>(
        `select greatest(
                  clock_timestamp() + interval '1 minute',
                  min(expires_at)
                ) as retry_at
           from app.preview_runs
          where workspace_id=$1 and prior_preview_run_id=$2
         having count(*) > 0`,
        [parsed.workspaceId, parsed.previewRunId],
      );
      if (child.rows[0] !== undefined) {
        const successor = await insertCleanupDelivery(client, {
          availableAt: child.rows[0].retry_at,
          previewRunId: parsed.previewRunId,
          ...(payload.traceparent === undefined
            ? {}
            : { traceparent: payload.traceparent }),
          workspaceId: parsed.workspaceId,
        });
        await completeReceipt(client, parsed.workspaceId, input.delivery);
        return Object.freeze({
          kind: 'rescheduled',
          cleanupOutboxEventId: successor,
        });
      }
      const selected = await client.query<{
        artifact_id: string;
        eligible: boolean;
        retry_at: Date;
      }>(
        `select link.artifact_id,
                artifact.status='deleting'
                and artifact.updated_at <= clock_timestamp()
                  - make_interval(secs => $4) as eligible,
                clock_timestamp() + make_interval(secs => $4) as retry_at
           from app.artifact_links link
           join app.artifacts artifact
             on artifact.workspace_id=link.workspace_id
            and artifact.id=link.artifact_id
          where link.workspace_id=$1
            and link.owner_kind='preview_run'
            and link.owner_id=$2
            and artifact.status in ('pending','available','deleting')
          order by link.artifact_id
          limit $3
          for update of artifact skip locked`,
        [
          parsed.workspaceId,
          parsed.previewRunId,
          parsed.artifactLimit,
          parsed.artifactQuiescenceSeconds,
        ],
      );
      const selectedIds = selected.rows.map((row) => row.artifact_id);
      if (selectedIds.length > 0) {
        await client.query(
          `update app.artifacts
              set status='deleting',updated_at=clock_timestamp()
            where workspace_id=$1 and id=any($2::uuid[])
              and status in ('pending','available')`,
          [parsed.workspaceId, selectedIds],
        );
      }
      const artifactIds = selected.rows
        .filter((row) => row.eligible)
        .map((row) => row.artifact_id);
      if (selectedIds.length > 0 && artifactIds.length === 0) {
        const retryAt = selected.rows[0]?.retry_at;
        if (retryAt === undefined)
          throw new PreviewCleanupStateError('database_clock_missing');
        const successor = await insertCleanupDelivery(client, {
          availableAt: retryAt,
          previewRunId: parsed.previewRunId,
          ...(payload.traceparent === undefined
            ? {}
            : { traceparent: payload.traceparent }),
          workspaceId: parsed.workspaceId,
        });
        await completeReceipt(client, parsed.workspaceId, input.delivery);
        return Object.freeze({
          kind: 'rescheduled',
          cleanupOutboxEventId: successor,
        });
      }
      return Object.freeze({
        kind: 'claimed',
        artifacts: Object.freeze(
          artifactIds.map((artifactId) =>
            Object.freeze({ artifactId, workspaceId: parsed.workspaceId }),
          ),
        ),
      });
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

export async function completePreviewArtifactDeletion(
  pool: Pool,
  input: Readonly<{
    artifactId: string;
    previewRunId: string;
    signal?: AbortSignal;
    workspaceId: string;
  }>,
): Promise<void> {
  const parsed = z
    .object({
      artifactId: z.uuid(),
      previewRunId: z.uuid(),
      workspaceId: z.uuid(),
    })
    .parse(input);
  await withTenantScopedClient(
    pool,
    { workspaceId: parsed.workspaceId },
    async (client) => {
      const artifact = await client.query<{ status: string }>(
        `select artifact.status
           from app.artifact_links link
           join app.artifacts artifact
             on artifact.workspace_id=link.workspace_id
            and artifact.id=link.artifact_id
          where link.workspace_id=$1 and link.owner_kind='preview_run'
            and link.owner_id=$2 and link.artifact_id=$3
          for update of artifact`,
        [parsed.workspaceId, parsed.previewRunId, parsed.artifactId],
      );
      const state = artifact.rows[0];
      if (state === undefined)
        throw new PreviewCleanupStateError('artifact_not_owned');
      if (state.status === 'deleted') return;
      if (state.status !== 'deleting')
        throw new PreviewCleanupStateError('artifact_not_claimed');
      const completed = await client.query(
        `update app.artifacts
            set status='deleted',deleted_at=clock_timestamp(),
                updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2 and status='deleting'`,
        [parsed.workspaceId, parsed.artifactId],
      );
      if (completed.rowCount !== 1)
        throw new PreviewCleanupStateError('artifact_completion_lost');
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

export async function finishPreviewCleanupDelivery(
  pool: Pool,
  input: Readonly<{
    delivery: PreviewDelivery;
    artifactQuiescenceSeconds?: number;
    previewRunId: string;
    signal?: AbortSignal;
    workspaceId: string;
  }>,
): Promise<PreviewCleanupFinishResult> {
  const parsed = z
    .object({
      artifactQuiescenceSeconds: z.number().int().min(1).max(120).default(60),
      previewRunId: z.uuid(),
      workspaceId: z.uuid(),
    })
    .parse(input);
  return withTenantScopedClient(
    pool,
    { workspaceId: parsed.workspaceId },
    async (client) => {
      const payload = await validateDelivery(client, {
        delivery: input.delivery,
        previewRunId: parsed.previewRunId,
        workspaceId: parsed.workspaceId,
      });
      if (
        (await claimReceipt(client, parsed.workspaceId, input.delivery)) ===
        'completed'
      )
        return Object.freeze({ kind: 'completed' });
      const unfinished = await client.query<{
        present: boolean;
        retry_at: Date | null;
      }>(
        `select exists (
           select 1
             from app.artifact_links link
             join app.artifacts artifact
               on artifact.workspace_id=link.workspace_id
              and artifact.id=link.artifact_id
            where link.workspace_id=$1 and link.owner_kind='preview_run'
              and link.owner_id=$2 and artifact.status <> 'deleted'
         ) as present,
         (select greatest(
                   clock_timestamp(),
                   min(artifact.updated_at + make_interval(secs => $3))
                 )
            from app.artifact_links link
            join app.artifacts artifact
              on artifact.workspace_id=link.workspace_id
             and artifact.id=link.artifact_id
           where link.workspace_id=$1 and link.owner_kind='preview_run'
             and link.owner_id=$2 and artifact.status='deleting'
         ) as retry_at`,
        [
          parsed.workspaceId,
          parsed.previewRunId,
          parsed.artifactQuiescenceSeconds,
        ],
      );
      if (unfinished.rows[0]?.present === true) {
        const successor = await insertCleanupDelivery(client, {
          ...(unfinished.rows[0].retry_at === null
            ? {}
            : { availableAt: unfinished.rows[0].retry_at }),
          previewRunId: parsed.previewRunId,
          ...(payload.traceparent === undefined
            ? {}
            : { traceparent: payload.traceparent }),
          workspaceId: parsed.workspaceId,
        });
        await completeReceipt(client, parsed.workspaceId, input.delivery);
        return Object.freeze({
          kind: 'continued',
          cleanupOutboxEventId: successor,
        });
      }
      const cleaned = await client.query<{ completed: boolean }>(
        `select app.complete_preview_cleanup($1,$2) as completed`,
        [parsed.workspaceId, parsed.previewRunId],
      );
      if (cleaned.rows[0]?.completed !== true) {
        const retry = await client.query<{ retry_at: Date }>(
          `select clock_timestamp() + interval '1 minute' as retry_at`,
        );
        const retryAt = retry.rows[0]?.retry_at;
        if (retryAt === undefined)
          throw new PreviewCleanupStateError('database_clock_missing');
        const successor = await insertCleanupDelivery(client, {
          availableAt: retryAt,
          previewRunId: parsed.previewRunId,
          ...(payload.traceparent === undefined
            ? {}
            : { traceparent: payload.traceparent }),
          workspaceId: parsed.workspaceId,
        });
        await completeReceipt(client, parsed.workspaceId, input.delivery);
        return Object.freeze({
          kind: 'continued',
          cleanupOutboxEventId: successor,
        });
      }
      await completeReceipt(client, parsed.workspaceId, input.delivery);
      return Object.freeze({ kind: 'completed' });
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}
