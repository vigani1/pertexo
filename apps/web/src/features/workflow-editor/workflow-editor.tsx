import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { useMemo, useState } from 'react';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import { connectionDiscoveryQueryOptions } from '@/features/connections/queries.public';
import {
  useAutoValidation,
  useWorkflowCommandSession,
  WorkflowCommandActions,
  workflowIssuesView,
} from '@/features/workflow-publish/public';
import { workflowRunKeys } from '@/features/workflow-runs/queries.public';
import {
  workflowKeys,
  workflowSummaryQueryOptions,
} from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { EditorCommandBar } from './components/chrome/editor-command-bar';
import { ConflictBar } from './components/chrome/conflict-bar';
import { ConflictCompareDialog } from './components/chrome/conflict-compare-dialog';
import {
  LeaveEditorDialog,
  UnfinishedEditDialog,
} from './components/chrome/editor-dialogs';
import { EditorPaused } from './components/chrome/editor-paused';
import { EditorWorkspace } from './components/editor-workspace';
import { EditorProvider } from './model/editor-provider';
import { useCanvasEffects } from './use-canvas-effects';
import {
  useEditorStore,
  useEditorStoreApi,
} from './model/editor-store-context';
import { useEditorActions } from './use-editor-actions';
import { useEditorSavePipeline } from './use-editor-save-pipeline';
import { useEditorSessionVerification } from './use-editor-session-verification';
import { useLeaveGuard } from './use-leave-guard';
import { workflowDraftQueryOptions } from './workflow-editor.queries';

export function WorkflowEditorPage({
  apiClient,
  user,
  workspace,
  workflowId,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
  onRunAccepted: (runId: string) => void;
}>) {
  const draft = useSuspenseQuery(
    workflowDraftQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const catalog = useSuspenseQuery(
    authoringCatalogQueryOptions(apiClient, user.id),
  );
  const connections = useSuspenseQuery(
    connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
  );
  return (
    <EditorProvider
      key={`${user.id}:${workspace.id}:${workflowId}`}
      initial={{
        graph: draft.data.draft.graph,
        etag: draft.data.etag,
        revision: draft.data.draft.revision,
        savedAt: draft.data.draft.updatedAt,
      }}
    >
      <ReactFlowProvider>
        <WorkflowEditorSession
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
          definitions={catalog.data.definitions.items}
          connections={connections.data.items}
          onRunAccepted={onRunAccepted}
        />
      </ReactFlowProvider>
    </EditorProvider>
  );
}

/**
 * One authenticated editing session: identity fencing, the save pipeline,
 * server commands, automatic checks and the guards around them. Layout and
 * editing surfaces live in `EditorWorkspace`.
 */
function WorkflowEditorSession({
  apiClient,
  userId,
  workspace,
  workflowId,
  definitions,
  connections,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  onRunAccepted: (runId: string) => void;
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
  const canUpdate = workspace.capabilities.includes('workflow:update');
  const verification = useEditorSessionVerification({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });
  const pauseReason = verification.pauseReason;
  const paused = pauseReason !== undefined;
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
    onRunAccepted,
    onRunCommandAccepted: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspace.id),
      });
    },
    onPublicationAccepted: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspace.id),
      });
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
  const { validation, validationPending, validationError } = publication;
  const issues = useMemo(
    () =>
      workflowIssuesView(
        { validation, validationPending, validationError },
        graph,
        { generation, revision },
      ),
    [
      generation,
      graph,
      revision,
      validation,
      validationError,
      validationPending,
    ],
  );
  const actions = useEditorActions({ store, isPaused: verification.isPaused });
  const effects = useCanvasEffects(graph);
  const [compareOpen, setCompareOpen] = useState(false);

  return (
    <>
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
          workspace={workspace}
          workflowId={workflowId}
          definitions={definitions}
          connections={connections}
          canUpdate={canUpdate}
          paused={paused}
          issues={issues}
          checking={validationPending}
          actions={actions}
          ensureSaved={ensureSaved}
          flushSave={flushSave}
          effects={effects}
          bar={(chrome) => (
            <EditorCommandBar
              workspace={workspace}
              workflowId={workflowId}
              workflow={workflow.data}
              shortcutsOpen={chrome.shortcutsOpen}
              onShortcutsOpenChange={chrome.onShortcutsOpenChange}
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
                    apiClient={apiClient}
                    userId={userId}
                    workspace={workspace}
                    workflowId={workflowId}
                    workflow={workflow.data}
                    graph={graph}
                    draft={{ generation, revision }}
                    commandSession={commandSession}
                    issues={issues}
                    onCheckAgain={autoValidation.checkNow}
                    onFix={chrome.onFix}
                    onPublished={effects.weaveIn}
                  />
                )
              }
            />
          )}
          banner={
            <ConflictBar
              onCompare={() => {
                setCompareOpen(true);
              }}
            />
          }
        />
        <ConflictCompareDialog
          open={compareOpen}
          onOpenChange={setCompareOpen}
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
