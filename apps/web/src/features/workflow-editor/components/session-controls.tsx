import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowSummary,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  WorkflowCommandActions,
  type useWorkflowCommandSession,
} from '@/features/workflow-publish/public';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { EditorCommandBar } from './chrome/editor-command-bar';
import { ConflictCompareDialog } from './chrome/conflict-compare-dialog';
import { UnfinishedEditDialog } from './chrome/editor-dialogs';
import type { EditorChrome } from './editor-workspace';
import type { useEditorActions } from '../hooks/use-editor-actions';
import type { useIssuesView } from '../hooks/use-issues-view';
import type { useCanvasEffects } from '../hooks/use-canvas-effects';
import type { EditorStore } from '../model/state/store';

type SessionCommandBarProps = Readonly<{
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
    workflowId: string;
    workflow: WorkflowSummary | undefined;
  }>;
  editing: Readonly<{
    paused: boolean;
    actions: ReturnType<typeof useEditorActions>;
    flushSave: () => Promise<void>;
    onReviewConflict: () => void;
    headerPresence: ReactNode;
  }>;
  publication: Readonly<{
    commandSession: ReturnType<typeof useWorkflowCommandSession>;
    graph: WorkflowGraphContract;
    generation: number;
    revision: number;
    saveStatus: ReturnType<EditorStore['getState']>['saveStatus'];
    inspectorScratch: boolean;
    issues: ReturnType<typeof useIssuesView>;
    triggersAvailable: boolean;
    effects: ReturnType<typeof useCanvasEffects>;
  }>;
  chrome: EditorChrome;
}>;
export function SessionCommandBar({
  scope,
  editing,
  publication,
  chrome,
}: SessionCommandBarProps) {
  const { apiClient, userId, workspace, workflowId, workflow } = scope;
  const { paused, actions, flushSave, onReviewConflict, headerPresence } =
    editing;
  const {
    commandSession,
    graph,
    generation,
    revision,
    saveStatus,
    inspectorScratch,
    issues,
    triggersAvailable,
    effects,
  } = publication;
  return (
    <EditorCommandBar
      presence={headerPresence}
      paused={paused}
      apiClient={apiClient}
      userId={userId}
      workspace={workspace}
      workflowId={workflowId}
      workflow={workflow}
      shortcutsOpen={chrome.shortcutsOpen}
      onShortcutsOpenChange={chrome.onShortcutsOpenChange}
      testMenuItems={chrome.workflowTestMenuItems}
      onRetrySave={() => void flushSave()}
      onReviewConflict={onReviewConflict}
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
            workspace={workspace}
            workflowId={workflowId}
            workflow={workflow}
            graph={graph}
            draft={{ generation, revision }}
            savedDraftCurrent={saveStatus === 'clean' && !inspectorScratch}
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
  );
}
export function SessionDialogs({
  comparison,
  actions,
  paused,
}: Readonly<{
  comparison: Readonly<{
    open: boolean;
    onOpenChange: (value: boolean) => void;
  }>;
  actions: ReturnType<typeof useEditorActions>;
  paused: boolean;
}>) {
  return (
    <>
      <ConflictCompareDialog
        open={comparison.open}
        onOpenChange={comparison.onOpenChange}
      />
      <ConfirmDialog
        state={{
          open: actions.pendingRemoval !== undefined,
          onOpenChange: (open) => {
            if (!open) actions.cancelRemoval();
          },
          locked: false,
        }}
        title="Remove this failure path?"
        description="The owned handler steps are removed with the link, so they cannot become ordinary starting steps. The source stops this run on failure again. Undo restores the whole path."
        onSubmit={actions.confirmRemoval}
        submitDisabled={paused}
        footer={
          <ConfirmationFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <ProgressButton
              type="submit"
              variant="destructive"
              pendingLabel="Remove failure path"
              disabled={paused}
            >
              Remove failure path
            </ProgressButton>
          </ConfirmationFooter>
        }
      >
        <ConfirmationDetails
          consequences={actions.pendingRemoval?.labels ?? []}
        />
      </ConfirmDialog>
      <UnfinishedEditDialog
        open={actions.pendingAction !== undefined}
        onDiscard={actions.discardAndContinue}
        onStay={actions.stay}
      />
    </>
  );
}
