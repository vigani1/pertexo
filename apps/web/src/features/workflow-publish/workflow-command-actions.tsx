import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type {
  WorkflowGraphContract,
  WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpFromLineIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { IssuesChip } from './components/issues-chip';
import { PublishLens } from './components/publish-lens';
import { PublishedStamp } from './components/published-stamp';
import { RunLens } from './components/run-lens';
import { RunMenu } from './components/run-menu';
import type { WorkflowIssuesView } from './model/issues-state';
import { summarizePublish } from './model/publish-summary';
import type { WorkflowValidationTarget } from './model/validation-target';
import type { PublicationReceipt } from './mutations/use-workflow-publication';
import type { WorkflowCommandSession } from './use-workflow-command-session';
import { latestVersionQueryOptions } from './workflow-publish.queries';

/**
 * The Build tab's commands in the hub bar: the issues chip, Run ▾ and the
 * one filled action, Publish vN. Each opens its own lens; the published stamp
 * follows a successful publish.
 */
export function WorkflowCommandActions({
  apiClient,
  userId,
  workspace,
  workflowId,
  workflow,
  graph,
  draft,
  commandSession,
  issues,
  onCheckAgain,
  onFix,
  onPublished,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  graph: WorkflowGraphContract;
  /** The draft on screen, to say whether it changed since this publish. */
  draft: Readonly<{ generation: number; revision: number }>;
  commandSession: WorkflowCommandSession;
  issues: WorkflowIssuesView;
  onCheckAgain: () => void;
  onFix: (target: WorkflowValidationTarget) => void;
  onPublished: (receipt: PublicationReceipt) => void;
}>) {
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [stamp, setStamp] = useState<PublicationReceipt>();
  const { publication, runSubmission } = commandSession;
  const receipt = publication.publicationReceipt;
  const everPublished =
    receipt !== undefined || (workflow?.publishedVersionId ?? null) !== null;
  const latest = useQuery({
    ...latestVersionQueryOptions(apiClient, userId, workspace.id, workflowId),
    enabled: everPublished,
  });
  const latestVersion = everPublished ? latest.data : null;
  const summary =
    latestVersion === undefined ||
    (workflow === undefined && receipt === undefined)
      ? undefined
      : summarizePublish(graph, latestVersion);
  const versionLabel =
    summary === undefined ? undefined : `v${String(summary.nextVersionNumber)}`;
  const canPublish = workspace.capabilities.includes('workflow:publish');
  const canRun = workspace.capabilities.includes('run:start');
  const blockingGroups =
    issues.groups !== undefined && !issues.stale ? issues.groups : [];

  async function confirmPublish() {
    const result = await publication.publish();
    if (result.kind !== 'published') return;
    setPublishOpen(false);
    setStamp(result.receipt);
    onPublished(result.receipt);
  }

  async function runNow() {
    const accepted = await runSubmission.startNew({ value: {} });
    if (!accepted) setRunOpen(true);
  }

  return (
    <>
      <IssuesChip
        state={issues}
        graph={graph}
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
        onCheckAgain={onCheckAgain}
        onFix={onFix}
      />
      {canRun ? (
        <RunMenu
          published={workflow === undefined || everPublished}
          pending={runSubmission.pending}
          acceptedRunPending={runSubmission.acceptedRunId !== undefined}
          onRunNow={() => void runNow()}
          onRunWithInput={() => {
            setRunOpen(true);
          }}
          onOpenAcceptedRun={() => void runSubmission.openAcceptedRun()}
        />
      ) : null}
      {receipt === undefined ? null : (
        <span className="hidden font-mono text-[0.7rem] whitespace-nowrap text-subtle-foreground sm:inline">
          v{receipt.versionNumber} live
          {receipt.generation !== draft.generation ||
          receipt.revision !== draft.revision
            ? ' · edited since'
            : ''}
        </span>
      )}
      {canPublish ? (
        <Button
          type="button"
          size="sm"
          variant="primary"
          onClick={() => {
            publication.clearPublishError();
            setPublishOpen(true);
          }}
        >
          <ArrowUpFromLineIcon data-icon="inline-start" />
          {versionLabel === undefined ? 'Publish' : `Publish ${versionLabel}`}
        </Button>
      ) : null}
      <PublishLens
        open={publishOpen}
        onOpenChange={setPublishOpen}
        versionLabel={versionLabel ?? 'this draft'}
        summary={summary}
        summaryState={
          summary !== undefined
            ? 'ready'
            : everPublished && latest.isPending
              ? 'loading'
              : 'error'
        }
        graph={graph}
        stage={publication.publishStage}
        error={publication.publishError}
        recoveryPending={publication.publishRecoveryPending}
        blockingGroups={blockingGroups}
        onPublish={() => void confirmPublish()}
        onFix={onFix}
      />
      <RunLens
        open={runOpen}
        pending={runSubmission.pending}
        error={runSubmission.error}
        retryAvailable={runSubmission.retryAvailable}
        onOpenChange={setRunOpen}
        onRetry={runSubmission.retry}
        onStartNew={runSubmission.startNew}
      />
      {stamp === undefined ? null : (
        <PublishedStamp
          key={stamp.versionId}
          workspaceId={workspace.id}
          workflowId={workflowId}
          versionNumber={stamp.versionNumber}
          hasTriggers={(summary?.triggerNames.length ?? 0) > 0}
          canRun={canRun}
          onRunNow={() => {
            setStamp(undefined);
            void runNow();
          }}
          onDismiss={() => {
            setStamp(undefined);
          }}
        />
      )}
    </>
  );
}
