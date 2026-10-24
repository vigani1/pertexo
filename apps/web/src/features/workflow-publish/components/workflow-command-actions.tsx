import { PublicationControls } from './publication/controls';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { workflowRunVersionQueryOptions } from '@/features/workflow-runs/queries.public';
import type {
  AccessibleWorkspace,
  WorkflowGraphContract,
  WorkflowSummary,
} from '@pertexo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { IssuesChip } from './validation/issues-chip';
import { PublishedStamp } from './publication/published-stamp';
import { RunInputDialog } from './run-submission/run-input-dialog';
import { PublishedRunAction } from './run-submission/published-run-action';
import type { WorkflowIssuesView } from '../model/validation/issues-state';
import { emptyDraftHint } from '../model/publication/readiness';
import type { WorkflowValidationTarget } from '../model/validation/target';
import type { PublicationReceipt } from '../data/mutations/use-workflow-publication';
import type { WorkflowCommandSession } from '../hooks/use-workflow-command-session';

function usePublishedFormEntry({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  activeVersionId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  activeVersionId: string | undefined;
}>) {
  const navigate = useNavigate();
  const liveVersion = useQuery({
    ...workflowRunVersionQueryOptions({
      apiClient,
      userId,
      workspaceId,
      workflowId,
      versionId: activeVersionId ?? '',
    }),
    enabled: activeVersionId !== undefined,
  });
  const liveIsForm =
    liveVersion.data?.graph.nodes.some(
      (node) =>
        node.definition.key === 'core.form' && node.definition.version === 1,
    ) === true;
  async function openForm(versionId: string | undefined) {
    if (
      !liveIsForm ||
      (versionId !== undefined && versionId !== activeVersionId)
    )
      return false;
    await navigate({
      to: '/w/$workspaceId/forms/$workflowId',
      params: { workspaceId, workflowId },
    });
    return true;
  }
  return { liveVersion, liveIsForm, openForm };
}

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
/**
 * The Build tab's commands in the hub bar: the issues chip, Run ▾ and the
 * one filled action, Publish vN. Each opens its own lens; the published stamp
 * follows a successful publish. The issues lens is the editor's to place, so
 * whether it's open comes from the editor.
 */
export function WorkflowCommandActions({
  renderFeedback,
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
  testAction,
  savedDraftCurrent = false,
}: Readonly<{
  testAction?: ReactNode;
  savedDraftCurrent?: boolean;
  renderFeedback: (feedback: ReactNode) => ReactNode;
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
  const [runOpen, setRunOpen] = useState(false);
  const [stamp, setStamp] = useState<
    Readonly<{
      receipt: PublicationReceipt;
      liveAgain: boolean;
      hasTriggers: boolean;
    }>
  >();
  const queryClient = useQueryClient();
  const { publication, runSubmission } = commandSession;
  const receipt = publication.publicationReceipt;
  const { liveVersion, liveIsForm, openForm } = usePublishedFormEntry({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
    activeVersionId: workflow?.publishedVersionId ?? receipt?.versionId,
  });
  const everPublished =
    receipt !== undefined || (workflow?.publishedVersionId ?? null) !== null;
  const canPublish = workspace.capabilities.includes('workflow:publish');
  const canRun = workspace.capabilities.includes('run:start');
  const emptyHint = emptyDraftHint(graph, triggersAvailable);

  /**
   * Starts the live version with no input. When that can't start (it needs
   * input, the version changed, the outcome is unclear), the run dialog
   * opens with the reason and the way forward.
   */
  async function runNow(
    publishedVersionId = workflow?.publishedVersionId ?? undefined,
  ) {
    if (await openForm(publishedVersionId)) return;
    const started = await runSubmission.startNew({
      value: {},
      ...(publishedVersionId === undefined
        ? {}
        : { expectedPublishedVersionId: publishedVersionId }),
    });
    if (!started) setRunOpen(true);
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 max-sm:flex-1">
        <IssuesChip
          state={issues}
          emptyHint={emptyHint}
          open={issuesOpen}
          onOpenChange={onIssuesOpenChange}
        />
        {testAction}
        <PublishedRunAction
          form={liveIsForm}
          canRun={canRun}
          workspaceId={workspace.id}
          workflowId={workflowId}
          submission={runSubmission}
          published={workflow === undefined || everPublished}
          loading={liveVersion.isFetching}
          onRunNow={() => {
            void runNow();
          }}
          onRunWithInput={() => {
            setRunOpen(true);
          }}
        />
        {receipt === undefined ? null : (
          <EditedSinceNote receipt={receipt} draft={draft} />
        )}
        {canPublish ? (
          <PublicationControls
            scope={{ apiClient, userId, workspaceId: workspace.id }}
            workflowId={workflowId}
            workflow={workflow}
            graph={graph}
            revision={draft.revision}
            publication={publication}
            isSavedDraftCurrent={commandSession.isSavedDraftCurrent}
            issues={issues}
            emptyHint={emptyHint}
            savedDraftCurrent={savedDraftCurrent}
            capabilities={workspace.capabilities}
            onFix={onFix}
            onPublished={(nextReceipt, hasTriggers) => {
              setStamp({
                receipt: nextReceipt,
                hasTriggers,
                liveAgain:
                  workflow?.publishedVersionId != null &&
                  workflow.publishedVersionId !== nextReceipt.versionId,
              });
              onPublished(nextReceipt);
            }}
          />
        ) : null}
      </div>
      <RunInputDialog
        key={`${userId}:${workspace.id}:${workflowId}`}
        open={runOpen}
        pending={runSubmission.pending}
        error={runSubmission.error}
        retryAvailable={runSubmission.retryAvailable}
        recoveryIntent={runSubmission.recoveryIntent}
        publicationConflict={runSubmission.publicationConflict}
        onReviewPublication={async () => {
          const reviewed = await queryClient.query({
            ...workflowSummaryQueryOptions(
              apiClient,
              userId,
              workspace.id,
              workflowId,
            ),
            staleTime: 0,
          });
          if (reviewed.publishedVersionId === null)
            throw new Error('No published version is available to review.');
          runSubmission.clearPublicationConflict();
          return reviewed.publishedVersionId;
        }}
        onOpenChange={setRunOpen}
        onRetry={runSubmission.retry}
        onStartNew={runSubmission.startNew}
        {...(workflow === undefined
          ? {}
          : { caseScope: { apiClient, userId, workspace, workflow } })}
      />
      {stamp === undefined
        ? null
        : renderFeedback(
            <PublishedStamp
              key={stamp.receipt.versionId}
              workspaceId={workspace.id}
              workflowId={workflowId}
              versionNumber={stamp.receipt.versionNumber}
              reused={stamp.receipt.reused}
              liveAgain={stamp.liveAgain}
              hasTriggers={stamp.hasTriggers}
              canRun={canRun}
              onRunNow={() => {
                setStamp(undefined);
                void runNow(stamp.receipt.versionId);
              }}
              onDismiss={() => {
                setStamp(undefined);
              }}
            />,
          )}
    </>
  );
}
