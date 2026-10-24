import { Notice } from '@/components/ui/notice';
import { workflowWorkspaceAccess } from '@/features/workflows/access.public';
import {
  editorPresenceSource,
  type EditorPresenceSource,
} from '../model/state/presence';
import type { CodeSettings } from '@pertexo/node-sdk';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import type {
  NodeDefinitionCatalogItem,
  ConnectionResponse,
  AccessibleWorkspace,
} from '@pertexo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import {
  IssuesLens,
  useAutoValidation,
  useWorkflowCommandSession,
  WorkflowCommandActions,
} from '@/features/workflow-publish/public';
import { workflowRunKeys } from '@/features/workflow-runs/queries.public';
import {
  workflowKeys,
  workflowOrganizationKeys,
  workflowSummaryQueryOptions,
} from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { EditorCommandBar } from './chrome/editor-command-bar';
import { ConflictBar } from './chrome/conflict-bar';
import { ConflictCompareDialog } from './chrome/conflict-compare-dialog';
import {
  LeaveEditorDialog,
  UnfinishedEditDialog,
} from './chrome/editor-dialogs';
import { EditorPaused } from './chrome/editor-paused';
import { EditorWorkspace } from './editor-workspace';
import { isStartTrigger } from '../model/step-catalog';
import { useCanvasEffects } from '../hooks/use-canvas-effects';
import { useEditorStore, useEditorStoreApi } from '../model/state/context';
import { useEditorActions } from '../hooks/use-editor-actions';
import { useEditorSavePipeline } from '../hooks/use-editor-save-pipeline';
import { useEditorSessionVerification } from '../hooks/use-editor-session-verification';
import { useLeaveGuard } from '../hooks/use-leave-guard';
import { workflowConnectionIssues } from '../model/connection-issues';
import { workflowPlaceholderIssues } from '../model/inspector/http-body';
import { useIssuesView } from '../hooks/use-issues-view';

/**
 * One authenticated editing session: identity fencing, the save pipeline,
 * server commands, automatic checks and the guards around them. Layout and
 * editing surfaces live in `EditorWorkspace`.
 */
export function WorkflowEditorSession({
  apiClient,
  userId,
  workspace,
  workflowId,
  definitions,
  codeSettings,
  connections,
  connectionsAvailable,
  onRunAccepted,
  onPublished,
  triggerNotice,
  headerPresence,
  renderEditingPresence,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  codeSettings?: CodeSettings | undefined;
  connections: readonly ConnectionResponse[];
  connectionsAvailable: boolean;
  onRunAccepted: (runId: string) => void;
  onPublished?: () => void;
  triggerNotice?: ReactNode;
  headerPresence?: ReactNode;
  renderEditingPresence?: (source: EditorPresenceSource) => ReactNode;
}>) {
  const store = useEditorStoreApi();
  const queryClient = useQueryClient();
  const workflow = useQuery(
    workflowSummaryQueryOptions(apiClient, userId, workspace.id, workflowId),
  );
  const graph = useEditorStore((state) => state.graph);
  const generation = useEditorStore((state) => state.generation);
  const revision = useEditorStore((state) => state.revision);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const inspectorScratch = useEditorStore((state) => state.inspectorScratch);
  const scopedWorkspace = workflowWorkspaceAccess(
    workspace,
    workflow.data?.resourceAccess,
  );
  const canUpdate = scopedWorkspace.capabilities.includes('workflow:update');
  const verification = useEditorSessionVerification({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });
  const pauseReason = verification.pauseReason;
  const paused = pauseReason !== undefined;
  const presenceSource = useMemo(
    () => editorPresenceSource({ store, editing: canUpdate && !paused }),
    [store, canUpdate, paused],
  );
  const { flushSave, ensureSaved } = useEditorSavePipeline({
    apiClient,
    store,
    workspaceId: workspace.id,
    workflowId,
    canUpdate,
    paused,
    verifyOwner: verification.verifyOwner,
  });
  const guard = useLeaveGuard({ store, flushSave });
  const commandSession = useWorkflowCommandSession({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
    verifyIdentity: verification.verifyOwner,
    isSessionPaused: verification.isPaused,
    ensureSaved,
    isSavedDraftCurrent: (saved) => {
      const current = store.getState();
      return (
        !verification.isPaused() &&
        current.saveStatus === 'clean' &&
        !current.inspectorScratch &&
        current.etag === saved.etag &&
        current.generation === saved.generation &&
        current.revision === saved.revision
      );
    },
    onRunAccepted,
    onRunCommandAccepted: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspace.id),
      });
    },
    onPublicationAccepted: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.scope(userId, workspace.id),
      });
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspace.id),
      });
      onPublished?.();
    },
  });
  const { publication } = commandSession;
  const autoValidation = useAutoValidation({
    publication,
    enabled: !paused,
    saveStatus,
    inspectorScratch,
    revision,
    generation,
  });
  const connectionIssues = useMemo(
    () => [
      ...workflowConnectionIssues({
        graph,
        definitions,
        connections,
        available: connectionsAvailable,
      }),
      ...workflowPlaceholderIssues(graph),
    ],
    [graph, definitions, connections, connectionsAvailable],
  );
  const issues = useIssuesView(
    publication,
    graph,
    { generation, revision },
    connectionIssues,
  );
  const actions = useEditorActions({ store, isPaused: verification.isPaused });
  const effects = useCanvasEffects(graph);
  const triggersAvailable = definitions.some(isStartTrigger);
  const [compareOpen, setCompareOpen] = useState(false);

  return (
    <>
      {renderEditingPresence?.(presenceSource)}
      {pauseReason === undefined ? null : (
        <EditorPaused
          reason={pauseReason}
          verifying={verification.verificationPending}
          workspaceId={workspace.id}
          onVerify={() => void verification.verifyOriginalAccount()}
        />
      )}
      <div hidden={paused} inert={paused}>
        <EditorWorkspace
          apiClient={apiClient}
          userId={userId}
          workspace={scopedWorkspace}
          workflowId={workflowId}
          definitions={definitions}
          codeSettings={codeSettings}
          connections={connections}
          connectionsAvailable={connectionsAvailable}
          canUpdate={canUpdate}
          paused={paused}
          issues={issues}
          checking={publication.validationPending}
          actions={actions}
          ensureSaved={ensureSaved}
          flushSave={flushSave}
          effects={effects}
          workflow={workflow.data}
          verifyIdentity={verification.verifyOwner}
          bar={(chrome) => (
            <EditorCommandBar
              presence={headerPresence}
              paused={paused}
              apiClient={apiClient}
              userId={userId}
              workspace={scopedWorkspace}
              workflowId={workflowId}
              workflow={workflow.data}
              shortcutsOpen={chrome.shortcutsOpen}
              onShortcutsOpenChange={chrome.onShortcutsOpenChange}
              testMenuItems={chrome.workflowTestMenuItems}
              onRetrySave={() => void flushSave()}
              onReviewConflict={() => {
                setCompareOpen(true);
              }}
              onUndo={() => {
                actions.request({ kind: 'undo' });
              }}
              onRedo={() => {
                actions.request({ kind: 'redo' });
              }}
              commands={
                paused ? null : (
                  <WorkflowCommandActions
                    renderFeedback={chrome.renderFeedback}
                    apiClient={apiClient}
                    userId={userId}
                    workspace={scopedWorkspace}
                    workflowId={workflowId}
                    workflow={workflow.data}
                    graph={graph}
                    draft={{ generation, revision }}
                    savedDraftCurrent={
                      saveStatus === 'clean' && !inspectorScratch
                    }
                    commandSession={commandSession}
                    testAction={chrome.workflowTestAction}
                    issues={issues}
                    issuesOpen={chrome.issuesOpen}
                    triggersAvailable={triggersAvailable}
                    onIssuesOpenChange={chrome.onIssuesOpenChange}
                    onFix={chrome.onFix}
                    onPublished={(receipt) => {
                      if (!receipt.reused) effects.weaveIn();
                    }}
                  />
                )
              }
            />
          )}
          bottomLens={(chrome) =>
            paused ? null : (
              <IssuesLens
                open={chrome.issuesOpen}
                state={issues}
                graph={graph}
                triggersAvailable={triggersAvailable}
                onOpenChange={chrome.onIssuesOpenChange}
                onCheckAgain={autoValidation.checkNow}
                onFix={chrome.onFix}
              />
            )
          }
          banner={
            <>
              {!canUpdate ? (
                <Notice>
                  View-only access. Ask a workspace owner or admin for access to
                  edit, publish or test this draft.
                </Notice>
              ) : null}
              {triggerNotice}
              <ConflictBar
                onCompare={() => {
                  setCompareOpen(true);
                }}
              />
            </>
          }
        />
        <ConflictCompareDialog
          open={compareOpen}
          onOpenChange={setCompareOpen}
        />
        <ConfirmDialog
          open={actions.pendingRemoval !== undefined}
          onOpenChange={(open) => {
            if (!open) actions.cancelRemoval();
          }}
          title="Remove this failure path?"
          description="The owned handler steps are removed with the link, so they cannot become ordinary starting steps. The source stops this run on failure again. Undo restores the whole path."
          consequences={actions.pendingRemoval?.labels ?? []}
          tone="destructive"
          confirmLabel="Remove failure path"
          confirmDisabled={paused}
          onConfirm={actions.confirmRemoval}
        />
        <UnfinishedEditDialog
          open={actions.pendingAction !== undefined}
          onDiscard={actions.discardAndContinue}
          onStay={actions.stay}
        />
      </div>
      <LeaveEditorDialog
        blocker={guard.blocker}
        reason={guard.reason}
        saving={guard.saving}
        onSaveAndLeave={() => void guard.saveAndLeave()}
      />
    </>
  );
}
