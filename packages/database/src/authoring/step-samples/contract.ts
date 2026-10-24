import type { workflowStepSamples } from '../../schema/authoring/step-samples.js';
import type { PoolClient } from 'pg';
import type { StepSampleSource } from '@pertexo/workflow-model';
import type { StoredExecutionValue } from '../../platform/stored-execution-value.js';

export type SampleScope = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  signal?: AbortSignal;
}>;
export type SampleNodeScope = SampleScope & Readonly<{ nodeId: string }>;
export type SampleCommand = SampleNodeScope &
  Readonly<{
    expectedDraftRevision: number;
    expectedSampleId: string | null;
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
  }>;
export type SampleSource = StepSampleSource;
export type SampleRow = Readonly<
  Pick<
    typeof workflowStepSamples.$inferSelect,
    | 'id'
    | 'nodeId'
    | 'binding'
    | 'outputRef'
    | 'retainedBytes'
    | 'sourceKind'
    | 'sourceRunId'
    | 'sourceNodeRunId'
    | 'sourcePreviewId'
    | 'createdAt'
    | 'expiresAt'
  >
>;
export type SampleState = 'pinned' | 'stale' | 'expired';
export type SampleMetadata = Readonly<{
  id: string;
  nodeId: string;
  binding: string;
  state: SampleState;
  source:
    | Exclude<
        SampleSource,
        { kind: 'confirm' } | { kind: 'json' } | { kind: 'webhook_test' }
      >
    | { kind: 'json' | 'webhook_test' };
  createdAt: Date;
  expiresAt: Date;
}>;
export type SampleRead = Readonly<{
  sample: SampleMetadata | null;
  output: StoredExecutionValue | null;
  draftRevision: number;
}>;
export type SampleResult = Readonly<{
  sampleId: string;
  removed: boolean;
  replayed: boolean;
}>;
export interface WorkflowStepSampleStore {
  list(
    input: SampleScope,
  ): Promise<{ items: readonly SampleMetadata[]; draftRevision: number }>;
  get(input: SampleNodeScope): Promise<SampleRead>;
  put(input: SampleCommand & { source: SampleSource }): Promise<SampleResult>;
  remove(
    input: SampleCommand & { expectedSampleId: string },
  ): Promise<SampleResult>;
}
export type SampleTransaction = <T>(
  input: SampleScope,
  options: Readonly<{
    write: boolean;
    work: (client: PoolClient) => Promise<T>;
  }>,
) => Promise<T>;
export class WorkflowStepSampleError extends Error {
  override readonly name = 'WorkflowStepSampleError';
  constructor(
    readonly reason:
      | 'changed'
      | 'draft_changed'
      | 'expired'
      | 'stale'
      | 'source_unavailable'
      | 'file_output'
      | 'value_invalid'
      | 'limit_reached'
      | 'step_unavailable',
  ) {
    super(`workflow.sample_${reason}`);
  }
}
export const SAMPLE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const SAMPLE_RETAINED_BYTES = 16 * 1024 * 1024;

export type SampleMetadataRow = Omit<SampleRow, 'outputRef' | 'retainedBytes'>;
