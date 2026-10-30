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
import { RunInputDialog } from './run-submission/input-dialog';
import { PublishedRunAction } from './run-submission/published-action';
import type { WorkflowIssuesView } from '../model/validation/issues-state';
import { emptyDraftHint } from '../model/publication/readiness';
import type { WorkflowValidationTarget } from '../model/validation/target';
import type { PublicationReceipt } from '../data/mutations/use-workflow-publication';
import type { WorkflowCommandSession } from '../hooks/use-workflow-command-session';
import { UserFacingError } from '@/lib/api/error';

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
    ) ?? false;
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
type WorkflowCommandActionsProps = Readonly<{
  testAction?: ReactNode;
  renderFeedback: (feedback: ReactNode) => ReactNode;
  commandSession: WorkflowCommandSession;
  onPublished: (receipt: PublicationReceipt) => void;
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
    workflowId: string;
  }>;
  snapshot: Readonly<{
    savedDraftCurrent?: boolean;
    workflow: WorkflowSummary | undefined;
    graph: WorkflowGraphContract;
    /** The draft on screen, to say whether it changed since this publish. */
    draft: Readonly<{ generation: number; revision: number }>;
    /** The catalog offers a trigger to start an empty draft with. */
    triggersAvailable: boolean;
  }>;
  validation: Readonly<{
    issues: WorkflowIssuesView;
    issuesOpen: boolean;
    onIssuesOpenChange: (open: boolean) => void;
    onFix: (target: WorkflowValidationTarget) => void;
  }>;
}>;

export function WorkflowCommandActions(props: WorkflowCommandActionsProps) {
  const model = useWorkflowCommandActions(props);
  const stamp = model.stamp;
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 max-sm:flex-1">
        <IssuesChip
          state={model.issues}
          emptyHint={model.emptyHint}
          open={model.issuesOpen}
          onOpenChange={model.onIssuesOpenChange}
        />
        {model.testAction}
        <PublishedRunAction
          form={model.liveIsForm}
          canRun={model.canRun}
          submission={model.runSubmission}
          published={model.workflow === undefined || model.everPublished}
          loading={model.liveVersion.isFetching}
          onRunNow={() => {
            void model.runNow();
          }}
          onRunWithInput={() => {
            model.setRunOpen(true);
          }}
          scope={{
            workspaceId: model.workspace.id,
            workflowId: model.workflowId,
          }}
        />
        {model.receipt === undefined ? null : (
          <EditedSinceNote receipt={model.receipt} draft={model.draft} />
        )}
        {model.canPublish ? (
          <PublicationControls
            scope={{
              apiClient: model.apiClient,
              userId: model.userId,
              workspaceId: model.workspace.id,
            }}
            workflowId={model.workflowId}
            publication={model.publication}
            capabilities={model.workspace.capabilities}
            onPublished={(nextReceipt, hasTriggers) => {
              model.setStamp({
                receipt: nextReceipt,
                hasTriggers,
                liveAgain:
                  model.workflow?.publishedVersionId != null &&
                  model.workflow.publishedVersionId !== nextReceipt.versionId,
              });
              model.onPublished(nextReceipt);
            }}
            validation={{
              issues: model.issues,
              emptyHint: model.emptyHint,
              onFix: model.onFix,
            }}
            draft={{
              workflow: model.workflow,
              graph: model.graph,
              revision: model.draft.revision,
              isSavedDraftCurrent: model.commandSession.isSavedDraftCurrent,
              savedDraftCurrent: model.savedDraftCurrent,
            }}
          />
        ) : null}
      </div>
      <RunInputDialog
        key={`${model.userId}:${model.workspace.id}:${model.workflowId}`}
        {...(model.workflow === undefined
          ? {}
          : {
              caseScope: {
                apiClient: model.apiClient,
                userId: model.userId,
                workspace: model.workspace,
                workflow: model.workflow,
              },
            })}
        publication={{
          publicationConflict: model.runSubmission.publicationConflict,
          onReviewPublication: async () => {
            const reviewed = await model.queryClient.query({
              ...workflowSummaryQueryOptions(
                model.apiClient,
                model.userId,
                model.workspace.id,
                model.workflowId,
              ),
              staleTime: 0,
            });
            if (reviewed.publishedVersionId === null)
              throw new UserFacingError(
                'No published version is available to review.',
              );
            model.runSubmission.clearPublicationConflict();
            return reviewed.publishedVersionId;
          },
        }}
        command={{
          pending: model.runSubmission.pending,
          error: model.runSubmission.error,
          retryAvailable: model.runSubmission.retryAvailable,
          recoveryIntent: model.runSubmission.recoveryIntent,
          onRetry: model.runSubmission.retry,
          onStartNew: model.runSubmission.startNew,
        }}
        state={{ open: model.runOpen, onOpenChange: model.setRunOpen }}
      />
      {stamp === undefined
        ? null
        : model.renderFeedback(
            <PublishedStamp
              key={stamp.receipt.versionId}
              versionNumber={stamp.receipt.versionNumber}
              reused={stamp.receipt.reused}
              liveAgain={stamp.liveAgain}
              hasTriggers={stamp.hasTriggers}
              canRun={model.canRun}
              onRunNow={() => {
                model.setStamp(undefined);
                void model.runNow(stamp.receipt.versionId);
              }}
              onDismiss={() => {
                model.setStamp(undefined);
              }}
              scope={{
                workspaceId: model.workspace.id,
                workflowId: model.workflowId,
              }}
            />,
          )}
    </>
  );
}

function useWorkflowCommandActions({
  renderFeedback,
  commandSession,
  onPublished,
  testAction,
  scope,
  snapshot,
  validation,
}: WorkflowCommandActionsProps) {
  const { apiClient, userId, workspace, workflowId } = scope;

  const {
    workflow,
    graph,
    draft,
    triggersAvailable,
    savedDraftCurrent = false,
  } = snapshot;

  const { issues, issuesOpen, onIssuesOpenChange, onFix } = validation;

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
  const emptyHint = emptyDraftHint({ graph, triggersAvailable });

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

  return {
    issues,
    emptyHint,
    issuesOpen,
    onIssuesOpenChange,
    testAction,
    liveIsForm,
    canRun,
    workspace,
    workflowId,
    runSubmission,
    workflow,
    everPublished,
    liveVersion,
    runNow,
    setRunOpen,
    receipt,
    draft,
    canPublish,
    graph,
    publication,
    commandSession,
    savedDraftCurrent,
    onFix,
    setStamp,
    onPublished,
    userId,
    runOpen,
    queryClient,
    apiClient,
    stamp,
    renderFeedback,
  } as const;
}
