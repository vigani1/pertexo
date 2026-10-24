import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowStepSamples } from '../../schema/authoring/step-samples.js';
import { auditEvents } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { sampleProjection, sampleDraft } from './records.repository.js';
import { captureSampleSource } from './source.queries.js';
import {
  SAMPLE_RETAINED_BYTES,
  SAMPLE_RETENTION_SECONDS,
  WorkflowStepSampleError,
  type SampleCommand,
  type SampleResult,
  type SampleRow,
  type SampleSource,
  type SampleTransaction,
} from './contract.js';

const resultSchema = z
  .object({ sampleId: z.uuid(), removed: z.boolean() })
  .strict();
export async function mutateStepSample(
  transact: SampleTransaction,
  input: SampleCommand,
  source: SampleSource | 'remove',
): Promise<SampleResult> {
  return transact(input, {
    write: true,
    work: async (client) => {
      const sampleId = generatePersistedId();
      const command = {
        workspaceId: input.workspaceId,
        operation:
          source === 'remove'
            ? 'workflow.sample.remove'
            : 'workflow.sample.put',
        scope: `${input.actorId}:${input.workflowId}`,
        idempotencyKey: input.idempotencyKey,
      };
      const stored = await claimCommand(client, {
        ...command,
        resourceId: sampleId,
        request: {
          nodeId: input.nodeId,
          expectedDraftRevision: input.expectedDraftRevision,
          expectedSampleId: input.expectedSampleId,
          source,
        },
      });
      if (stored !== null)
        return { ...resultSchema.parse(stored), replayed: true };
      const draft = await sampleDraft(client, input, { write: true });
      if (draft.revision !== input.expectedDraftRevision)
        throw new WorkflowStepSampleError('draft_changed');
      const binding = draft.bindings.get(input.nodeId);
      if (binding === undefined)
        throw new WorkflowStepSampleError('step_unavailable');
      const db = drizzle(client);
      await db
        .execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-step-sample-quota:${input.workspaceId}`},0))`,
        )
        .catch(rethrowQueryFailure);
      const [current] = await db
        .select(sampleProjection)
        .from(workflowStepSamples)
        .where(
          and(
            eq(workflowStepSamples.workspaceId, input.workspaceId),
            eq(workflowStepSamples.workflowId, input.workflowId),
            eq(workflowStepSamples.nodeId, input.nodeId),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      if ((current?.id ?? null) !== input.expectedSampleId)
        throw new WorkflowStepSampleError('changed');
      if (source === 'remove') {
        if (current === undefined) throw new WorkflowStepSampleError('changed');
        await db
          .delete(workflowStepSamples)
          .where(
            and(
              eq(workflowStepSamples.workspaceId, input.workspaceId),
              eq(workflowStepSamples.id, current.id),
            ),
          )
          .catch(rethrowQueryFailure);
      } else {
        await persistCapturedSample(client, input, {
          source,
          current,
          binding,
          sampleId,
        });
      }
      const receipt = {
        sampleId: source === 'remove' ? input.expectedSampleId : sampleId,
        removed: source === 'remove',
      };
      await db
        .insert(auditEvents)
        .values({
          id: generatePersistedId(),
          workspaceId: input.workspaceId,
          actorUserId: input.actorId,
          action:
            source === 'remove'
              ? 'workflow.sample.removed'
              : 'workflow.sample.saved',
          targetType: 'workflow_step_sample',
          targetId: receipt.sampleId,
          requestId: input.requestId ?? null,
          traceId: input.traceId ?? null,
          metadata: {
            workflowId: input.workflowId,
            nodeId: input.nodeId,
            sourceKind: source === 'remove' ? 'remove' : source.kind,
          },
        })
        .catch(rethrowQueryFailure);
      await completeCommand(client, command, receipt);
      return { ...resultSchema.parse(receipt), replayed: false };
    },
  });
}

async function assertSampleQuota(
  client: PoolClient,
  input: SampleCommand,
  {
    current,
    retainedBytes,
  }: Readonly<{ current: SampleRow | undefined; retainedBytes: number }>,
): Promise<void> {
  const [usage] = await drizzle(client)
    .select({
      bytes: sql<number>`coalesce(sum(${workflowStepSamples.retainedBytes}),0)::float8`,
      workspaceCount: sql<number>`count(*)::int`,
      workflowCount: sql<number>`count(*) filter(where ${workflowStepSamples.workflowId}=${input.workflowId})::int`,
    })
    .from(workflowStepSamples)
    .where(eq(workflowStepSamples.workspaceId, input.workspaceId))
    .catch(rethrowQueryFailure);
  if (usage === undefined) throw new Error('Sample quota is unavailable');
  const sampleQuotaExceeded =
    usage.bytes - (current?.retainedBytes ?? 0) + retainedBytes >
      SAMPLE_RETAINED_BYTES ||
    (current === undefined &&
      (usage.workflowCount >= 200 || usage.workspaceCount >= 1000));
  if (sampleQuotaExceeded) throw new WorkflowStepSampleError('limit_reached');
}

async function persistCapturedSample(
  client: PoolClient,
  input: SampleCommand,
  {
    source,
    current,
    binding,
    sampleId,
  }: Readonly<{
    source: SampleSource;
    current: SampleRow | undefined;
    binding: string;
    sampleId: string;
  }>,
): Promise<void> {
  const captured = await captureSampleSource(client, input, {
    source,
    current,
    binding,
  });
  const retainedBytes =
    utf8ByteLength(binding) + utf8ByteLength(captured.output);
  await assertSampleQuota(client, input, { current, retainedBytes });
  const values = {
    id: sampleId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    binding,
    outputRef: captured.output,
    retainedBytes,
    sourceKind: captured.kind,
    sourceRunId: captured.runId,
    sourceNodeRunId: captured.nodeRunId,
    sourcePreviewId: captured.previewId,
    createdBy: input.actorId,
    expiresAt: sql<Date>`clock_timestamp()+make_interval(secs=>${SAMPLE_RETENTION_SECONDS})`,
  };
  const updates = {
    id: values.id,
    binding: values.binding,
    outputRef: values.outputRef,
    retainedBytes: values.retainedBytes,
    sourceKind: values.sourceKind,
    sourceRunId: values.sourceRunId,
    sourceNodeRunId: values.sourceNodeRunId,
    sourcePreviewId: values.sourcePreviewId,
    createdBy: values.createdBy,
    expiresAt: sql<Date>`excluded.expires_at`,
  };
  await drizzle(client)
    .insert(workflowStepSamples)
    .values(values)
    .onConflictDoUpdate({
      target: [
        workflowStepSamples.workspaceId,
        workflowStepSamples.workflowId,
        workflowStepSamples.nodeId,
      ],
      set: { ...updates, createdAt: sql`clock_timestamp()` },
    })
    .catch(rethrowQueryFailure);
}
