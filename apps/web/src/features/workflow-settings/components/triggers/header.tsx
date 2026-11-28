import { PlayIcon } from 'lucide-react';
import { ProgressButton } from '@/components/ui/progress-button';
import type { WorkflowSummary } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { useRunWorkflow } from '@/features/workflows/public';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { buttonVariants } from '@/components/ui/button-variants';

/** What the tab is, and which published version its triggers come from. */
export function TriggersHeader({
  versions,
  publishedVersionId,
  runFromBuild,
  manualRun,
  commandScope,
}: Readonly<{
  versions:
    readonly Readonly<{ id: string; versionNumber: number }>[] | undefined;
  publishedVersionId: string | null | undefined;
  runFromBuild:
    Readonly<{ workspaceId: string; workflowId: string }> | undefined;
  manualRun: WorkflowSummary | undefined;
  commandScope: RunCommandScope;
}>) {
  const published = versions?.find(
    (version) => version.id === publishedVersionId,
  );
  return (
    <PageHeader>
      <div className="flex flex-col gap-2">
        <PageHeaderTitle size="section">Ways a run can start</PageHeaderTitle>
        <p className="text-meta text-subtle-foreground">
          {published === undefined
            ? 'From the published version.'
            : `From the published version, v${String(published.versionNumber)}.`}{' '}
          Turning a schedule off stops new runs from it right away; the draft is
          not touched.
        </p>
      </div>
      {runFromBuild === undefined || publishedVersionId == null ? null : (
        <PageHeaderActions>
          <Link
            to="/w/$workspaceId/workflows/$workflowId"
            params={runFromBuild}
            className={buttonVariants({
              variant: manualRun === undefined ? 'outline' : 'ghost',
            })}
          >
            {manualRun === undefined
              ? 'Run in Build'
              : 'Run with input in Build'}
          </Link>
          <RunPublishedWorkflow workflow={manualRun} scope={commandScope} />
        </PageHeaderActions>
      )}
    </PageHeader>
  );
}

type RunCommandScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

function RunPublishedWorkflow({
  workflow,
  scope,
}: Readonly<{
  workflow: WorkflowSummary | undefined;
  scope: RunCommandScope;
}>) {
  const navigate = useNavigate();
  const runner = useRunWorkflow({
    ...scope,
    onRunStarted: (runId) => {
      void navigate({
        to: '/w/$workspaceId/runs/$runId',
        params: { workspaceId: scope.workspaceId, runId },
      });
    },
  });
  if (workflow === undefined) return null;
  return (
    <ProgressButton
      type="button"
      variant="outline"
      pending={runner.pendingId === workflow.id}
      pendingLabel="Starting…"
      icon={<PlayIcon data-icon="inline-start" />}
      onClick={() => {
        void runner.run(workflow);
      }}
    >
      Run now
    </ProgressButton>
  );
}
