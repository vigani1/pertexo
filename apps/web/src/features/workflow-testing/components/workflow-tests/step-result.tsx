import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { describeNodeStatus } from '@/features/workflow-runs/labels.public';
import { useTestHistory } from '../../hooks/use-test-history';
import type { WorkflowTests } from '../../hooks/use-workflow-tests';
import { WORKFLOW_TEST_HISTORY_ID } from './history';
import { StepFailure, TestOutputValue } from './results';

export function WorkflowStepTestResult({
  tests,
  nodeId,
  onViewHistory,
}: Readonly<{
  tests: WorkflowTests;
  nodeId: string;
  onViewHistory: () => void;
}>) {
  const latest = useTestHistory({ scope: tests.scope, enabled: tests.enabled });
  const step = latest.progress.data?.nodes.find(
    (node) => node.nodeId === nodeId,
  );
  if (step === undefined || latest.activeId === undefined) return null;
  const state = describeNodeStatus(step.status);
  return (
    <section
      aria-label="Latest workflow test"
      className="flex min-w-0 flex-col gap-3 border-b border-border pb-4"
    >
      <h3 className="text-sm font-semibold">Latest workflow test</h3>
      <Status tone={state.tone}>{state.label}</Status>
      <p className="text-xs text-muted-foreground">
        Draft {latest.snapshot.data?.draftRevision}
      </p>
      <StepFailure step={step} />
      {step.status === 'succeeded' ? (
        <TestOutputValue
          tests={tests}
          runId={latest.activeId}
          nodeRunId={step.id}
          status={step.status}
        />
      ) : null}
      <Button
        variant="link"
        size="sm"
        onClick={() => {
          if (latest.activeId !== undefined) tests.selectRun(latest.activeId);
          tests.showHistory();
          onViewHistory();
          requestAnimationFrame(() =>
            document.getElementById(WORKFLOW_TEST_HISTORY_ID)?.focus(),
          );
        }}
      >
        View full test history
      </Button>
    </section>
  );
}
