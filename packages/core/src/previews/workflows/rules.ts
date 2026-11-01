import { canonicalJson } from '@pertexo/workflow-model';
import type {
  WorkflowTestCommand,
  WorkflowTestPreparation,
} from './contract.js';
import { WorkflowTestError } from './errors.js';

/** A test of one step at a time, however long the workflow itself may run. */
const TEST_RUN_MAX_DURATION_MS = 5 * 60 * 1_000;

/** A test still taking up its place: only one may run per person and workflow. */
export const ACTIVE_TEST_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
] as const;

export function isActiveTestRun(status: string): boolean {
  return ACTIVE_TEST_RUN_STATUSES.some((active) => active === status);
}

export function testRunDurationMs(
  maxRunDurationMs: number | undefined,
): number {
  return Math.min(
    TEST_RUN_MAX_DURATION_MS,
    maxRunDurationMs ?? TEST_RUN_MAX_DURATION_MS,
  );
}

export function sameTestSamples(
  left: readonly { nodeId: string; sampleId: string }[],
  right: readonly { nodeId: string; sampleId: string }[],
) {
  const sort = (items: typeof left) =>
    [...items].sort((a, b) => {
      if (a.nodeId < b.nodeId) {
        return -1;
      }
      if (a.nodeId > b.nodeId) {
        return 1;
      }
      return 0;
    });
  return canonicalJson(sort(left)) === canonicalJson(sort(right));
}

/** Whoever starts a test saw these steps, and agreed to what they do. */
export function assertEffectsAcknowledged(
  request: Pick<
    WorkflowTestCommand['request'],
    'expectedEffectfulSteps' | 'acknowledgeSideEffects'
  >,
  effectfulSteps: WorkflowTestPreparation['effectfulSteps'],
): void {
  if (
    canonicalJson([...request.expectedEffectfulSteps].sort()) !==
    canonicalJson(effectfulSteps.map((step) => step.nodeId).sort())
  )
    throw new WorkflowTestError('effects_changed');
  if (effectfulSteps.length > 0 && !request.acknowledgeSideEffects)
    throw new WorkflowTestError('effects_acknowledgement_required');
}
