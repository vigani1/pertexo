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
export type SampleRow = Readonly<{
  id: string;
  node_id: string;
  binding: string;
  output_ref: string;
  retained_bytes: number;
  source_kind: 'json' | 'run' | 'preview';
  source_run_id: string | null;
  source_node_run_id: string | null;
  source_preview_id: string | null;
  created_at: Date;
  expires_at: Date;
}>;
export type SampleState = 'pinned' | 'stale' | 'expired';
export type SampleMetadata = Readonly<{
  id: string;
  nodeId: string;
  binding: string;
  state: SampleState;
  source:
    | Exclude<SampleSource, { kind: 'confirm' } | { kind: 'json' }>
    | { kind: 'json' };
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
  write: boolean,
  work: (client: PoolClient) => Promise<T>,
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
export const SAMPLE_COLUMNS =
  'id,node_id,binding,output_ref,retained_bytes,source_kind,source_run_id,source_node_run_id,source_preview_id,created_at,expires_at';
export const SAMPLE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const SAMPLE_RETAINED_BYTES = 16 * 1024 * 1024;

export type SampleMetadataRow = Omit<
  SampleRow,
  'output_ref' | 'retained_bytes'
>;
export const SAMPLE_METADATA_COLUMNS =
  'id,node_id,binding,source_kind,source_run_id,source_node_run_id,source_preview_id,created_at,expires_at';
