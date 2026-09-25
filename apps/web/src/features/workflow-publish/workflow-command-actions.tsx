import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type {
  WorkflowGraphContract,
  WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { IssuesChip } from './components/issues-chip';
import { PublishButton } from './components/publish-button';
import { PublishLens } from './components/publish-lens';
import { PublishedStamp } from './components/published-stamp';
import { RunLens } from './components/run-lens';
import { RunMenu } from './components/run-menu';
import type { WorkflowIssuesView } from './model/issues-state';
import { emptyDraftHint } from './model/publish-readiness';
import { summarizePublish } from './model/publish-summary';
import type { WorkflowValidationTarget } from './model/validation-target';
import type { PublicationReceipt } from './mutations/use-workflow-publication';
import type { WorkflowCommandSession } from './use-workflow-command-session';
import { latestVersionQueryOptions } from './workflow-publish.queries';

/**
 * "Edited since v4" once the draft moves on from what was just published.
 * The state line already names the live version, so nothing shows before.
 */
function EditedSinceNote({
  receipt,
  draft,
}: Readonly<{
  receipt: PublicationReceipt;
  draft: Readonly<{ generation: number; revision: number }>;
}>) {
  const edited =
    receipt.generation !== draft.generation ||
    receipt.revision !== draft.revision;
  if (!edited) return null;
  return (
    <span className="hidden font-mono text-[0.7rem] whitespace-nowrap text-subtle-foreground sm:inline">
      Edited since v{receipt.versionNumber}
    </span>
  );
}

/**
 * What publishing would change and the version it would make, once the
 * latest version (or that there is none) and the workflow are known.
 */
function usePublishPreview({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  workflow,
  graph,
  receipt,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  graph: WorkflowGraphContract;
  receipt: PublicationReceipt | undefined;
}>) {
  const everPublished =
    receipt !== undefined || (workflow?.publishedVersionId ?? null) !== null;
  const latest = useQuery({
    ...latestVersionQueryOptions(apiClient, userId, workspaceId, workflowId),
    enabled: everPublished,
  });
  const latestVersion = everPublished ? latest.data : null;
  const known = workflow !== undefined || receipt !== undefined;
  const summary =
    latestVersion === undefined || !known
      ? undefined
      : summarizePublish(graph, latestVersion);
  return {
    everPublished,
    summary,
    versionLabel:
      summary === undefined
        ? undefined
        : `v${String(summary.nextVersionNumber)}`,
    summaryState: summaryState(
      summary !== undefined,
      everPublished && latest.isPending,
    ),
  } as const;
}

function summaryState(
  ready: boolean,
  loading: boolean,
): 'ready' | 'loading' | 'error' {
  if (ready) return 'ready';
  return loading ? 'loading' : 'error';
}

/**
 * The Build tab's commands in the hub bar: the issues chip, Run ▾ and the
 * one filled action, Publish vN. Each opens its own lens; the published stamp
 * follows a successful publish. The issues lens is the editor's to place, so
 * whether it's open comes from the editor.
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
  issuesOpen,
  triggersAvailable,
  onIssuesOpenChange,
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
  issuesOpen: boolean;
  /** The catalog offers a trigger to start an empty draft with. */
  triggersAvailable: boolean;
  onIssuesOpenChange: (open: boolean) => void;
  onFix: (target: WorkflowValidationTarget) => void;
  onPublished: (receipt: PublicationReceipt) => void;
}>) {
  const [publishOpen, setPublishOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [stamp, setStamp] = useState<PublicationReceipt>();
  const { publication, runSubmission } = commandSession;
  const receipt = publication.publicationReceipt;
  const { everPublished, summary, versionLabel, ...preview } =
    usePublishPreview({
      apiClient,
      userId,
      workspaceId: workspace.id,
      workflowId,
      workflow,
      graph,
      receipt,
    });
  const canPublish = workspace.capabilities.includes('workflow:publish');
  const canRun = workspace.capabilities.includes('run:start');
  const blockingGroups =
    issues.groups !== undefined && !issues.stale ? issues.groups : [];
  const emptyHint = emptyDraftHint(graph, triggersAvailable);

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
        emptyHint={emptyHint}
        open={issuesOpen}
        onOpenChange={onIssuesOpenChange}
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
        <EditedSinceNote receipt={receipt} draft={draft} />
      )}
      {canPublish ? (
        <PublishButton
          versionLabel={versionLabel}
          blockedReason={emptyHint?.label}
          onClick={() => {
            publication.clearPublishError();
            setPublishOpen(true);
          }}
        />
      ) : null}
      <PublishLens
        open={publishOpen}
        onOpenChange={setPublishOpen}
        versionLabel={versionLabel ?? 'this draft'}
        summary={summary}
        summaryState={preview.summaryState}
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
