import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkflowNodeRunSummary } from '@pertexo/contracts';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { JsonTree } from '@/components/patterns/code/json-tree';
import { QueryView } from '@/components/patterns/states/query-view';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { ArtifactDownload } from '@/features/artifacts/artifacts-views.public';
import { describeNodeStatus } from '@/features/workflow-runs/public';
import { nodeRunOutputQueryOptions } from '@/features/workflow-runs/workflow-runs-queries.public';
import { formatDurationMs } from '@/lib/format/time';
import { useEditorSession } from '../../../model/state/context';
import { LastRunContext } from '../../../model/canvas/last-run-context';

export function AgentLastRun({ nodeId }: Readonly<{ nodeId: string }>) {
  const lastRun = use(LastRunContext);
  const step = lastRun?.nodeRuns.get(nodeId);
  if (lastRun === undefined || step === undefined) return null;
  const status = describeNodeStatus(step.status);
  const elapsed =
    step.startedAt === null || step.completedAt === null
      ? null
      : formatDurationMs(
          Date.parse(step.completedAt) - Date.parse(step.startedAt),
        );
  return (
    <section aria-label="Last run" className="flex min-w-0 flex-col gap-2">
      <RuleHeading appearance="compact">Output</RuleHeading>
      {step.status === 'succeeded' ? (
        <AgentOutput runId={lastRun.run.id} step={step} />
      ) : null}
      <div className="flex items-center gap-2 text-meta text-muted-foreground">
        <StatusMark tone={status.tone}>Last run: {status.label}</StatusMark>
        {elapsed === null ? null : <span>{elapsed}</span>}
      </div>
    </section>
  );
}

function AgentOutput({
  runId,
  step,
}: Readonly<{ runId: string; step: WorkflowNodeRunSummary }>) {
  const { scope, editing } = useEditorSession();
  const query = useQuery({
    ...nodeRunOutputQueryOptions({
      apiClient: scope.apiClient,
      userId: scope.userId,
      workspaceId: scope.workspace.id,
      runId,
      step: { nodeRunId: step.id, status: step.status },
    }),
    enabled: !editing.paused,
  });
  return (
    <QueryView query={query} resource="Last run output">
      {(output) => {
        switch (output.kind) {
          case 'inline':
            return (
              <JsonTree
                value={output.value}
                label="Last run output"
                className="max-h-40"
              />
            );
          case 'artifact':
            return (
              <ArtifactDownload
                apiClient={scope.apiClient}
                userId={scope.userId}
                workspaceId={scope.workspace.id}
                artifactId={output.artifactId}
              />
            );
          case 'none':
            return (
              <p className="text-meta text-muted-foreground">
                This step returned nothing.
              </p>
            );
          case 'expired':
            return (
              <p className="text-meta text-muted-foreground">
                This output has expired.
              </p>
            );
        }
      }}
    </QueryView>
  );
}
