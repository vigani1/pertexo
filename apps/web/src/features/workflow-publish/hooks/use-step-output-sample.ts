import type { PreviewRunSummary } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  nodeRunOutputQueryOptions,
  stepRunsQueryOptions,
  workflowRunQueryOptions,
} from '@/features/workflow-runs/queries.public';
import type { SampleScope } from '../data/samples/api';
import { stepSampleQueryOptions } from '../data/samples/queries';
import { workflowTestsQueryOptions } from '../data/workflow-tests/queries';

const RECENT_RUNS = 5;

type SampleOrigin = 'pin' | 'step_test' | 'workflow_test' | 'run';

export type StepOutputSample =
  | Readonly<{ kind: 'loading' }>
  /** Nothing to read: the step hasn't produced output anyone can still see. */
  | Readonly<{ kind: 'none' }>
  /** Its output is stored as a file, so it has no fields to list. */
  | Readonly<{ kind: 'file' }>
  | Readonly<{ kind: 'failed'; retry: () => void }>
  | Readonly<{ kind: 'value'; value: unknown; from: SampleOrigin }>;

type StepSampleInput = Readonly<{
  scope: SampleScope;
  nodeId: string;
  enabled: boolean;
}>;

type ReadableQuery = Readonly<{
  isError: boolean;
  refetch: () => Promise<unknown>;
}>;

/**
 * The output a step's later steps can expect: its pin, which tests really
 * use; else its last test in this session; else the latest workflow test or
 * real run where it succeeded. Reads nothing until `enabled`.
 */
export function useStepOutputSample({
  stepTest,
  ...input
}: StepSampleInput &
  Readonly<{
    stepTest: NonNullable<PreviewRunSummary['output']> | undefined;
  }>): StepOutputSample {
  const pinned = useQuery({
    ...stepSampleQueryOptions(input.scope, input.nodeId),
    enabled: input.enabled,
  });
  const pin =
    pinned.data?.sample?.state === 'expired' ? null : pinned.data?.output;
  const recorded = useRecordedOutput({
    ...input,
    enabled:
      input.enabled &&
      pinned.isSuccess &&
      pin == null &&
      stepTest === undefined,
  });
  if (!input.enabled) return { kind: 'none' };
  if (pinned.isError) return failedSample(pinned);
  if (pinned.isPending) return { kind: 'loading' };
  if (pin != null) return { kind: 'value', value: pin, from: 'pin' };
  if (stepTest === undefined) return recorded;
  return stepTest.kind === 'inline'
    ? { kind: 'value', value: stepTest.value, from: 'step_test' }
    : { kind: 'file' };
}

/** What the latest workflow test, else the latest real run, recorded. */
function useRecordedOutput(input: StepSampleInput): StepOutputSample {
  const { scope, enabled } = input;
  const found = useLatestSuccess(input);
  const run = found.kind === 'found' ? found : undefined;
  const output = useQuery({
    ...nodeRunOutputQueryOptions({
      apiClient: scope.apiClient,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      runId: run?.runId ?? '',
      step: { nodeRunId: run?.nodeRunId ?? '', status: 'succeeded' },
    }),
    enabled: enabled && run !== undefined,
  });
  if (found.kind !== 'found') return found;
  if (output.isError) return failedSample(output);
  if (output.isPending) return { kind: 'loading' };
  if (output.data.kind === 'inline')
    return { kind: 'value', value: output.data.value, from: found.from };
  return output.data.kind === 'artifact' ? { kind: 'file' } : { kind: 'none' };
}

type LatestSuccess =
  | Extract<StepOutputSample, { kind: 'loading' | 'none' | 'failed' }>
  | Readonly<{
      kind: 'found';
      runId: string;
      nodeRunId: string;
      from: 'workflow_test' | 'run';
    }>;

/**
 * Workflow tests come first because a person is working on this draft; the
 * step's run history holds only real runs, so it can't answer for them.
 */
function useLatestSuccess({
  scope,
  nodeId,
  enabled,
}: StepSampleInput): LatestSuccess {
  const { apiClient, userId, workspaceId, workflowId } = scope;
  const tests = useQuery({ ...workflowTestsQueryOptions(scope), enabled });
  const testRunId = tests.data?.items[0]?.runId;
  const testRun = useQuery({
    ...workflowRunQueryOptions(apiClient, userId, workspaceId, testRunId ?? ''),
    enabled: enabled && testRunId !== undefined,
  });
  const tested = testRun.data?.nodes.find(
    (node) => node.nodeId === nodeId && node.status === 'succeeded',
  );
  const testsAnswered =
    tests.isSuccess && (testRunId === undefined || testRun.isSuccess);
  const runs = useQuery({
    ...stepRunsQueryOptions(apiClient, userId, workspaceId, {
      workflowId,
      nodeId,
      limit: RECENT_RUNS,
    }),
    enabled: enabled && testsAnswered && tested === undefined,
  });
  for (const query of [tests, testRun, runs])
    if (query.isError) return failedSample(query);
  if (testRunId !== undefined && tested !== undefined)
    return {
      kind: 'found',
      runId: testRunId,
      nodeRunId: tested.id,
      from: 'workflow_test',
    };
  const ran = runs.data?.items.find((run) => run.status === 'succeeded');
  if (ran !== undefined)
    return {
      kind: 'found',
      runId: ran.runId,
      nodeRunId: ran.nodeRunId,
      from: 'run',
    };
  return runs.isSuccess ? { kind: 'none' } : { kind: 'loading' };
}

function failedSample(
  query: ReadableQuery,
): Extract<StepOutputSample, { kind: 'failed' }> {
  return {
    kind: 'failed',
    retry: () => {
      void query.refetch();
    },
  };
}
