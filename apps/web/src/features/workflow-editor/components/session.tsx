import { Notice } from '@/components/ui/notice';
import type { EditorPresenceSource } from '../model/state/presence';
import type { CodeSettings } from '@pertexo/node-sdk';
import type {
  NodeDefinitionCatalogItem,
  ConnectionResponse,
  AccessibleWorkspace,
} from '@pertexo/contracts';
import { useState, type ReactNode } from 'react';
import { IssuesLens } from '@/features/workflow-publish/public';
import type { ApiClient } from '@/lib/api/client';
import { ConflictBar } from './chrome/conflict-bar';
import { LeaveEditorDialog } from './chrome/editor-dialogs';
import { EditorPaused } from './chrome/editor-paused';
import { SessionCommandBar, SessionDialogs } from './session-controls';
import { EditorWorkspace } from './editor-workspace';
import { isStartTrigger } from '../model/step-catalog';
import { useCanvasEffects } from '../hooks/use-canvas-effects';
import { useEditorStoreApi } from '../model/state/context';
import { useEditorOwnership } from '../hooks/use-editor-ownership';
import { useEditorPublication } from '../hooks/use-editor-publication';
import { useEditorActions } from '../hooks/use-editor-actions';

/**
 * One authenticated editing session: identity fencing, the save pipeline,
 * server commands, automatic checks and the guards around them. Layout and
 * editing surfaces live in `EditorWorkspace`.
 */
type WorkflowEditorSessionProps = Readonly<{
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
}>;

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
}: WorkflowEditorSessionProps) {
  const store = useEditorStoreApi();
  const { workflow, access, verification, presenceSource, save, guard } =
    useEditorOwnership({ apiClient, userId, workspace, workflowId });
  const { workspace: scopedWorkspace, canUpdate } = access;
  const { flushSave, ensureSaved } = save;
  const pauseReason = verification.pauseReason;
  const paused = pauseReason !== undefined;
  const { commandSession, publication, autoValidation, issues, draft } =
    useEditorPublication({
      scope: { apiClient, userId, workspaceId: workspace.id, workflowId },
      verification,
      ensureSaved,
      paused,
      onRunAccepted,
      onPublished,
      catalog: { definitions, connections, connectionsAvailable },
    });
  const { graph, generation, revision, saveStatus, inspectorScratch } = draft;
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
            <SessionCommandBar
              scope={{
                apiClient,
                userId,
                workspace: scopedWorkspace,
                workflowId,
                workflow: workflow.data,
              }}
              editing={{
                paused,
                actions,
                flushSave,
                onReviewConflict: () => {
                  setCompareOpen(true);
                },
                headerPresence,
              }}
              publication={{
                commandSession,
                graph,
                generation,
                revision,
                saveStatus,
                inspectorScratch,
                issues,
                triggersAvailable,
                effects,
              }}
              chrome={chrome}
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
        <SessionDialogs
          comparison={{ open: compareOpen, onOpenChange: setCompareOpen }}
          actions={actions}
          paused={paused}
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
