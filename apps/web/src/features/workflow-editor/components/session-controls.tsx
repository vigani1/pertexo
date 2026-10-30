import { useEditorSession } from '../model/state/context';
import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';

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

import type { EditorStore } from '../model/state/store';

type SessionCommandBarProps = Readonly<{
  header: Readonly<{
    onReviewConflict: () => void;
    headerPresence: ReactNode;
  }>;
  publication: Readonly<{
    commandSession: ReturnType<typeof useWorkflowCommandSession>;
    graph: WorkflowGraphContract;
    generation: number;
    revision: number;
    saveStatus: ReturnType<EditorStore['getState']>['save']['status'];
    inspectorScratch: boolean;
    triggersAvailable: boolean;
  }>;
  chrome: EditorChrome;
}>;
export function SessionCommandBar({
  header,
  publication,
  chrome,
}: SessionCommandBarProps) {
  const { scope, editing } = useEditorSession();
  const { apiClient, userId, workspace, workflowId } = scope;
  const { workflow, paused, actions, flushSave, issues, effects } = editing;
  const { onReviewConflict, headerPresence } = header;
  const {
    commandSession,
    graph,
    generation,
    revision,
    saveStatus,
    inspectorScratch,
    triggersAvailable,
  } = publication;
  return (
    <EditorCommandBar
      presence={headerPresence}
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
            commandSession={commandSession}
            testAction={chrome.workflowTestAction}
            onPublished={(receipt) => {
              if (!receipt.reused) effects.weaveIn();
            }}
            validation={{
              issues,
              issuesOpen: chrome.issuesOpen,
              onIssuesOpenChange: chrome.onIssuesOpenChange,
              onFix: chrome.onFix,
            }}
            snapshot={{
              workflow,
              graph,
              draft: { generation, revision },
              savedDraftCurrent: saveStatus === 'clean' && !inspectorScratch,
              triggersAvailable,
            }}
            scope={{ apiClient, userId, workspace, workflowId }}
          />
        )
      }
      shortcuts={{
        open: chrome.shortcutsOpen,
        onOpenChange: chrome.onShortcutsOpenChange,
      }}
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
