import type { PoolClient } from 'pg';

import { inlineSampleOutput } from './step-sample-state.js';

import { WorkflowStepSampleError } from './step-sample.errors.js';

import type {
  SampleCommand,
  SampleRow,
  SampleSource,
} from './step-sample.types.js';

import {
  readSourceOutput,
  sampleExpired,
  shareLockTestEvent,
} from './source.repository.js';

export async function captureSampleSource(
  client: PoolClient,
  input: SampleCommand,
  {
    source,
    current,
    binding,
  }: Readonly<{
    source: SampleSource;
    current: SampleRow | undefined;
    binding: string;
  }>,
) {
  if (source.kind === 'confirm') {
    if (current === undefined) throw new WorkflowStepSampleError('changed');
    const expired = await sampleExpired(client, current.expiresAt);
    if (expired) throw new WorkflowStepSampleError('expired');
    return {
      output: current.outputRef,
      kind: current.sourceKind,
      runId: current.sourceRunId,
      nodeRunId: current.sourceNodeRunId,
      previewId: current.sourcePreviewId,
    };
  }
  if (source.kind === 'json')
    return {
      output: inlineSampleOutput({ kind: 'inline', value: source.value }),
      kind: source.kind,
      runId: null,
      nodeRunId: null,
      previewId: null,
    };
  if (source.kind === 'webhook_test') {
    const row = await shareLockTestEvent(client, input, {
      listenerId: source.listenerId,
      binding,
    });
    if (row === undefined)
      throw new WorkflowStepSampleError('source_unavailable');
    return {
      output: inlineSampleOutput(row.outputRef),
      kind: source.kind,
      runId: null,
      nodeRunId: null,
      previewId: null,
    };
  }
  const row = await readSourceOutput(client, input, source);
  if (row === undefined || row.outputRef === null)
    throw new WorkflowStepSampleError('source_unavailable');
  return {
    output: inlineSampleOutput(row.outputRef),
    kind: source.kind,
    runId: source.kind === 'run' ? source.runId : null,
    nodeRunId: source.kind === 'run' ? source.nodeRunId : null,
    previewId: source.kind === 'preview' ? source.previewRunId : null,
  };
}

export type CapturedSample = Awaited<ReturnType<typeof captureSampleSource>>;
