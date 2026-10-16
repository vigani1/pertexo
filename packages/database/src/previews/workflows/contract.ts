import type { SampleScope } from '../../authoring/step-samples/contract.js';

export type WorkflowTestPreparation = Readonly<{
  draftRevision: number;
  samples: readonly Readonly<{ nodeId: string; sampleId: string }>[];
  effectfulSteps: readonly Readonly<{ nodeId: string; label: string }>[];
}>;
export type WorkflowTestCommand = SampleScope &
  Readonly<{
    idempotencyKey: string;
    request: Readonly<{
      expectedRevision: number;
      expectedSamples: WorkflowTestPreparation['samples'];
      expectedEffectfulSteps: readonly string[];
      input: unknown;
      acknowledgeSideEffects: boolean;
    }>;
  }>;
export class WorkflowTestError extends Error {
  override readonly name = 'WorkflowTestError';
  constructor(
    readonly reason:
      | 'draft_changed'
      | 'samples_changed'
      | 'stale_sample'
      | 'pin_invalid'
      | 'not_supported'
      | 'effects_acknowledgement_required'
      | 'effects_changed'
      | 'already_running'
      | 'not_found',
  ) {
    super(`workflow.test_${reason}`);
  }
}
export interface WorkflowTestStore {
  prepare(input: SampleScope): Promise<WorkflowTestPreparation>;
  start(input: WorkflowTestCommand): Promise<{ runId: string }>;
  list(input: SampleScope): Promise<{ items: readonly WorkflowTestSummary[] }>;
  get(input: SampleScope & { runId: string }): Promise<WorkflowTestDetail>;
  cancel(input: SampleScope & { runId: string }): Promise<void>;
}
export type WorkflowTestSummary = Readonly<{
  runId: string;
  startedBy: string | null;
  draftRevision: number;
  status: string;
  createdAt: string;
  expiresAt: string;
}>;
export type WorkflowTestDetail = WorkflowTestSummary &
  Readonly<{
    graph: unknown;
    dispositions: Readonly<
      Record<
        string,
        | 'pinned'
        | 'wait_skipped'
        | 'response_skipped'
        | 'pin_required'
        | 'execute'
      >
    >;
  }>;
