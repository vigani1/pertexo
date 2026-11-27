import { useStepDescriptions } from '@/features/catalog/public';
import {
  describeStepError,
  describeNodeStatus,
} from '@/features/workflow-runs/public';
import { useMemo } from 'react';
import { QueryView } from '@/components/patterns/states/query-view';
import { ArtifactDownload } from '@/features/artifacts/artifacts-views.public';
import type { WorkflowRunData } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { Disclosure } from '@/components/ui/disclosure';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { JsonTree } from '@/components/patterns/code/json-tree';
import { nodeRunOutputQueryOptions } from '@/features/workflow-runs/workflow-runs-queries.public';
import { workflowTestStepLabels } from '../../model/workflow-test';
import { PinRecordedOutputButton } from '../samples/controls';
import type { WorkflowTests } from '../../data/workflow-tests/workflow-tests.mutations';
import { DATA_RETENTION_DAYS } from '@pertexo/workflow-model';
import { formatCount } from '@/lib/format/count';
import { TestCaseReport } from '../test-suites/report';

export function WorkflowTestResults({
  tests,
  ensureSaved,
}: Readonly<{
  tests: WorkflowTests;
  ensureSaved: () => Promise<{ revision: number }>;
}>) {
  const describeStep = useStepDescriptions();
  const labels = useMemo(
    () => workflowTestStepLabels(tests.snapshot.data?.graph, describeStep),
    [tests.snapshot.data?.graph, describeStep],
  );
  if (tests.snapshot.data === undefined) return null;
  const suite = tests.suites.detail.data;
  const evaluationCase =
    suite?.evaluation === undefined
      ? undefined
      : suite.cases.find(
          ({ runId, status }) =>
            runId === tests.activeId &&
            status !== 'pending' &&
            status !== 'running',
        );
  return (
    <>
      {suite === undefined || evaluationCase === undefined ? null : (
        <Disclosure
          summary={`Evaluation report for row ${String(evaluationCase.ordinal + 1)}`}
          lazy
        >
          <TestCaseReport
            scope={tests.scope}
            suiteId={suite.suiteId}
            ordinal={evaluationCase.ordinal}
          />
        </Disclosure>
      )}
      {tests.progress.data?.nodes.map((step) => {
        const disposition = tests.snapshot.data?.dispositions[step.nodeId];
        const state = describeNodeStatus(step.status);
        return (
          <section
            aria-label={`Test result: ${labels.get(step.nodeId) ?? step.nodeId}`}
            key={step.id}
            className="flex flex-col gap-2 border-t border-border/50 pt-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-all text-sm">
                {labels.get(step.nodeId) ?? step.nodeId}
              </span>
              <StatusMark tone={state.tone}>{state.label}</StatusMark>
              <DispositionLabel disposition={disposition} />
              {step.status === 'succeeded' && tests.activeId !== undefined ? (
                <>
                  <PinRecordedOutputButton
                    scope={tests.scope}
                    nodeId={step.nodeId}
                    runId={tests.activeId}
                    nodeRunId={step.id}
                    ensureSaved={ensureSaved}
                  />
                </>
              ) : null}
            </div>
            {step.status === 'succeeded' && tests.activeId !== undefined ? (
              <TestOutput
                tests={tests}
                runId={tests.activeId}
                nodeRunId={step.id}
                status={step.status}
              />
            ) : null}
            <StepFailure step={step} />
          </section>
        );
      })}
    </>
  );
}
function TestOutput(props: Readonly<TestOutputProps>) {
  return (
    <Disclosure summary="View output" lazy>
      <TestOutputValue {...props} />
    </Disclosure>
  );
}
/** A test step's output: its JSON, its file to download, or why there's none. */
function TestOutputData({
  data,
  scope,
}: Readonly<{ data: WorkflowRunData; scope: WorkflowTests['scope'] }>) {
  switch (data.kind) {
    case 'inline':
      return (
        <JsonTree
          value={data.value}
          label="Test step output"
          className="max-h-56"
        />
      );
    case 'artifact':
      return (
        <ArtifactDownload
          apiClient={scope.apiClient}
          userId={scope.userId}
          workspaceId={scope.workspaceId}
          artifactId={data.artifactId}
        />
      );
    case 'none':
      return <OutputNote>This step returned nothing.</OutputNote>;
    case 'expired':
      return (
        <OutputNote>
          {`No longer kept. Pertexo keeps test data for ${formatCount(DATA_RETENTION_DAYS.testRuns, 'day')}.`}
        </OutputNote>
      );
  }
}

function OutputNote({ children }: Readonly<{ children: string }>) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

interface TestOutputProps {
  tests: WorkflowTests;
  runId: string;
  nodeRunId: string;
  status: string;
}
/** Both the history fold and selected-step panel read the same retained output. */
export function TestOutputValue({
  tests,
  runId,
  nodeRunId,
  status,
}: Readonly<TestOutputProps>) {
  const output = useQuery(
    nodeRunOutputQueryOptions({
      apiClient: tests.scope.apiClient,
      userId: tests.scope.userId,
      workspaceId: tests.scope.workspaceId,
      runId,
      step: { nodeRunId, status },
    }),
  );
  return (
    <QueryView query={output} resource="Test step output">
      {(data) => <TestOutputData data={data} scope={tests.scope} />}
    </QueryView>
  );
}

function DispositionLabel({
  disposition,
}: Readonly<{
  disposition:
    | NonNullable<WorkflowTests['snapshot']['data']>['dispositions'][string]
    | undefined;
}>) {
  if (disposition === 'pinned') {
    return (
      <span className="text-xs text-muted-foreground">
        Pinned · step not called
      </span>
    );
  }
  if (disposition === 'wait_skipped') {
    return (
      <span className="text-xs text-muted-foreground">
        Wait skipped in test
      </span>
    );
  }
  if (disposition === 'response_skipped') {
    return (
      <span className="text-xs text-muted-foreground">
        Webhook response skipped in test
      </span>
    );
  }
  return null;
}

export function StepFailure({
  step,
}: Readonly<{
  step: Readonly<{
    safeErrorCode: string | null;
    errorSummary?: string | null | undefined;
  }>;
}>) {
  if (step.safeErrorCode === 'test.pin_required') {
    return (
      <p className="text-sm text-warning">
        Pin this step to continue the test.
      </p>
    );
  }
  if (step.safeErrorCode === null) {
    return null;
  }
  return (
    <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
      {step.errorSummary ?? describeStepError(step.safeErrorCode).sentence}
    </p>
  );
}
