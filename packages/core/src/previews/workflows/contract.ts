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
export type WorkflowTestRunInput = SampleScope & Readonly<{ runId: string }>;
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
