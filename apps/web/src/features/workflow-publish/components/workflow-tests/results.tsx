import { useMemo } from 'react';
import { QueryView } from '@/components/patterns/states/query-view';
import { useQuery } from '@tanstack/react-query';
import { Disclosure } from '@/components/ui/disclosure';
import { Status } from '@/components/ui/status';
import { JsonTree } from '@/components/patterns/code/json-tree';
import { describeNodeStatus } from '@/features/workflow-runs/run-labels.public';
import { nodeRunOutputQueryOptions } from '@/features/workflow-runs/queries.public';
import { workflowTestStepLabels } from '../../model/testing/workflow';
import { PinRecordedOutputButton } from '../samples/controls';
import type { WorkflowTests } from '../../hooks/use-workflow-tests';

export function WorkflowTestResults({
  tests,
  ensureSaved,
}: Readonly<{
  tests: WorkflowTests;
  ensureSaved: () => Promise<{ revision: number }>;
}>) {
  const labels = useMemo(
    () => workflowTestStepLabels(tests.snapshot.data?.graph),
    [tests.snapshot.data?.graph],
  );
  return (
    <>
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
              <Status tone={state.tone}>{state.label}</Status>
              {disposition === 'pinned' ? (
                <span className="text-xs text-muted-foreground">
                  Pinned · step not called
                </span>
              ) : disposition === 'wait_skipped' ? (
                <span className="text-xs text-muted-foreground">
                  Wait skipped in test
                </span>
              ) : disposition === 'response_skipped' ? (
                <span className="text-xs text-muted-foreground">
                  Webhook response skipped in test
                </span>
              ) : null}
              {step.status === 'succeeded' && tests.activeId !== undefined ? (
                <>
                  <TestOutput
                    tests={tests}
                    runId={tests.activeId}
                    nodeRunId={step.id}
                    status={step.status}
                  />
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
            {step.safeErrorCode === 'test.pin_required' ? (
              <p className="text-sm text-warning">
                Pin this step to continue the test.
              </p>
            ) : step.safeErrorCode === null ? null : (
              <p className="font-mono text-xs text-muted-foreground">
                {step.safeErrorCode}
              </p>
            )}
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
interface TestOutputProps {
  tests: WorkflowTests;
  runId: string;
  nodeRunId: string;
  status: string;
}
/** Read only once the fold opens: an output can be large. */
function TestOutputValue({
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
      {(data) =>
        data.kind === 'inline' ? (
          <JsonTree
            value={data.value}
            label="Test step output"
            className="max-h-56"
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            This output is stored as a file or is no longer available.
          </p>
        )
      }
    </QueryView>
  );
}
