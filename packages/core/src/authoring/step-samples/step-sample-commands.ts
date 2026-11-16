import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { utf8ByteLength, STEP_SAMPLE_LIMITS } from '@pertexo/workflow-model';
import { z } from 'zod';

import {
  deleteSample,
  lockCurrentSample,
  readSampleUsage,
  saveSample,
} from './step-sample-commands.repository.js';

import { decodeStoredValue } from '../../shared/stored-values.js';

import { appendAuditFact } from '../../governance/audit/facts.js';

import type { PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';

import { sampleDraft } from './step-sample-state.js';

import { captureSampleSource } from './capture-source.js';

import { WorkflowStepSampleError } from './step-sample.errors.js';

import type {
  SampleCommand,
  SampleResult,
  SampleRow,
  SampleSource,
  SampleTransaction,
} from './step-sample.types.js';

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
        return {
          ...decodeStoredValue(() => resultSchema.parse(stored)),
          replayed: true,
        };
      const draft = await sampleDraft(client, input, { write: true });
      if (draft.revision !== input.expectedDraftRevision)
        throw new WorkflowStepSampleError('draft_changed');
      const binding = draft.bindings.get(input.nodeId);
      if (binding === undefined)
        throw new WorkflowStepSampleError('step_unavailable');
      const current = await lockCurrentSample(client, input);
      if ((current?.id ?? null) !== input.expectedSampleId)
        throw new WorkflowStepSampleError('changed');
      let receiptSampleId = sampleId;
      if (source === 'remove') {
        if (current === undefined) throw new WorkflowStepSampleError('changed');
        receiptSampleId = current.id;
        await deleteSample(client, input.workspaceId, current.id);
      } else {
        await persistCapturedSample(client, input, {
          source,
          current,
          binding,
          sampleId,
        });
      }
      const receipt = {
        sampleId: receiptSampleId,
        removed: source === 'remove',
      };
      await appendAuditFact(client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
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
      });
      await completeCommand(client, command, receipt);
      return { ...receipt, replayed: false };
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
  const usage = await readSampleUsage(client, input);
  if (usage === undefined) throw new Error('Sample quota is unavailable');
  const sampleQuotaExceeded =
    usage.bytes - (current?.retainedBytes ?? 0) + retainedBytes >
      SAMPLE_RETAINED_BYTES ||
    (current === undefined &&
      (usage.workflowCount >= STEP_SAMPLE_LIMITS.perWorkflow ||
        usage.workspaceCount >= STEP_SAMPLE_LIMITS.perWorkspace));
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
  await saveSample(client, input, {
    sampleId,
    binding,
    captured,
    retainedBytes,
  });
}

const resultSchema = z
  .object({ sampleId: z.uuid(), removed: z.boolean() })
  .strict();

const SAMPLE_RETAINED_BYTES = 16 * 1024 * 1024;
