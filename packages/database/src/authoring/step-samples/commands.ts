import type { PoolClient } from 'pg';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';
import { claimCommand, completeCommand } from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { sampleDraft } from './records.js';
import { captureSampleSource } from './source.js';
import {
  SAMPLE_COLUMNS,
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
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`workflow-step-sample-quota:${input.workspaceId}`],
      );
      const result = await client.query<SampleRow>(
        `select ${SAMPLE_COLUMNS} from app.workflow_step_samples where workspace_id=$1 and workflow_id=$2 and node_id=$3 for update`,
        [input.workspaceId, input.workflowId, input.nodeId],
      );
      const current = result.rows[0];
      if ((current?.id ?? null) !== input.expectedSampleId)
        throw new WorkflowStepSampleError('changed');
      if (source === 'remove') {
        if (current === undefined) throw new WorkflowStepSampleError('changed');
        await client.query(
          'delete from app.workflow_step_samples where workspace_id=$1 and id=$2',
          [input.workspaceId, current.id],
        );
      } else {
        const captured = await captureSampleSource(client, input, {
          source,
          current,
          binding,
        });
        const retainedBytes =
          utf8ByteLength(binding) + utf8ByteLength(captured.output);
        await assertSampleQuota(client, input, { current, retainedBytes });
        await client.query(
          `insert into app.workflow_step_samples(id,workspace_id,workflow_id,node_id,binding,output_ref,retained_bytes,source_kind,source_run_id,source_node_run_id,source_preview_id,created_by,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+make_interval(secs=>$13)) on conflict(workspace_id,workflow_id,node_id) do update set id=excluded.id,binding=excluded.binding,output_ref=excluded.output_ref,retained_bytes=excluded.retained_bytes,source_kind=excluded.source_kind,source_run_id=excluded.source_run_id,source_node_run_id=excluded.source_node_run_id,source_preview_id=excluded.source_preview_id,created_by=excluded.created_by,created_at=clock_timestamp(),expires_at=excluded.expires_at`,
          [
            sampleId,
            input.workspaceId,
            input.workflowId,
            input.nodeId,
            binding,
            captured.output,
            retainedBytes,
            captured.kind,
            captured.runId,
            captured.nodeRunId,
            captured.previewId,
            input.actorId,
            SAMPLE_RETENTION_SECONDS,
          ],
        );
      }
      const receipt = {
        sampleId: source === 'remove' ? input.expectedSampleId : sampleId,
        removed: source === 'remove',
      };
      await client.query(
        `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata) values($1,$2,$3,$4,'workflow_step_sample',$5,$6,$7,$8::jsonb)`,
        [
          generatePersistedId(),
          input.workspaceId,
          input.actorId,
          source === 'remove'
            ? 'workflow.sample.removed'
            : 'workflow.sample.saved',
          receipt.sampleId,
          input.requestId ?? null,
          input.traceId ?? null,
          JSON.stringify({
            workflowId: input.workflowId,
            nodeId: input.nodeId,
            sourceKind: source === 'remove' ? 'remove' : source.kind,
          }),
        ],
      );
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
  const quota = await client.query<{
    bytes: string;
    workflow_count: string;
    workspace_count: string;
  }>(
    `select coalesce(sum(retained_bytes),0)::text bytes,count(*)::text workspace_count,count(*) filter(where workflow_id=$2)::text workflow_count from app.workflow_step_samples where workspace_id=$1`,
    [input.workspaceId, input.workflowId],
  );
  const usage = quota.rows[0];
  if (usage === undefined) throw new Error('Sample quota is unavailable');
  const sampleQuotaExceeded =
    Number(usage.bytes) - (current?.retained_bytes ?? 0) + retainedBytes >
      SAMPLE_RETAINED_BYTES ||
    (current === undefined &&
      (Number(usage.workflow_count) >= 200 ||
        Number(usage.workspace_count) >= 1000));
  if (sampleQuotaExceeded) throw new WorkflowStepSampleError('limit_reached');
}
