import type { WorkflowRunResponse } from '@pertexo/contracts';
import type { RunTimelineRow } from '../../model/timeline/runs';
import type { RunDataScope } from './data/value';
import { RunExplanation } from '../explanation';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { describeRunFailureReason } from '../../model/presentation/run-failure-reason';

export function RunFailureNotice({
  snapshot,
  scope,
  navigation,
}: Readonly<{
  snapshot: WorkflowRunResponse;
  scope: RunDataScope;
  navigation: Readonly<{
    rows: readonly RunTimelineRow[];
    selectStep: (key: string) => void;
  }>;
}>) {
  const reason = describeRunFailureReason(snapshot.run.failureReasonCode);
  const failed = snapshot.run.status === 'failed';
  if (!failed && reason === undefined) return null;
  return (
    <div className="flex flex-col gap-3">
      {reason === undefined ? null : (
        <Notice tone="destructive">
          <p>{reason}</p>
          <p>
            No failed step can safely be retried using saved results. Review
            earlier effects before starting a full replay.
          </p>
        </Notice>
      )}
      {failed ? (
        <RunExplanation
          key={scope.runId}
          apiClient={scope.apiClient}
          workspaceId={scope.workspace.id}
          runId={scope.runId}
          onSelectStep={(id) => {
            const step = navigation.rows
              .filter((row) => row.nodeId === id)
              .at(-1);
            if (step !== undefined) navigation.selectStep(step.key);
          }}
        />
      ) : null}
    </div>
  );
}
