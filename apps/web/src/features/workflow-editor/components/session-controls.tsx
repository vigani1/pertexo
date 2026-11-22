import { useEditorSession } from '../model/state/context';

import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import type { WorkflowGraphContract } from '@pertexo/contracts';

import { WorkflowCommandActions } from '@/features/workflow-publish/workflow-publish-views.public';
import type { useWorkflowCommandSession } from '@/features/workflow-publish/public';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { DraftProposal } from './draft-proposal';
import { EditorCommandBar } from './chrome/editor-command-bar';
import { ConflictCompareDialog } from './chrome/conflict-compare-dialog';
import { UnfinishedEditDialog } from './chrome/editor-dialogs';
import type { EditorChrome } from './editor-workspace';
import type { useEditorActions } from '../hooks/use-editor-actions';

import type { EditorStore } from '../model/state/workflow-editor.store';

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
  // The command bar is inside the contract dialog root. Give the proposal its own backdrop and focus scope.
  const [proposalHandle] = useState(DialogPrimitive.createHandle);
  const moreRef = useRef<HTMLButtonElement>(null);
  const proposalRef = useRef<HTMLButtonElement>(null);
  const canPropose = !paused && editing.canUpdate;

  function proposalFinalFocus() {
    const inline = proposalRef.current;
    if (inline !== null && inline.getClientRects().length > 0) return inline;
    // The phone menu item unmounts as the dialog opens.
    const more = moreRef.current;
    return more !== null && more.getClientRects().length > 0 ? more : true;
  }

  return (
    <>
      <EditorCommandBar
        presence={headerPresence}
        moreRef={moreRef}
        secondaryMenuItems={
          <>
            {canPropose ? (
              <DialogTrigger
                handle={proposalHandle}
                render={<DropdownMenuItem />}
              >
                Ask assistant
              </DialogTrigger>
            ) : null}
            {chrome.workflowTestMenuItems}
          </>
        }
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
            <>
              {canPropose ? (
                <DialogTrigger
                  ref={proposalRef}
                  handle={proposalHandle}
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="hidden sm:inline-flex"
                    />
                  }
                >
                  Ask assistant
                </DialogTrigger>
              ) : null}
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
                  savedDraftCurrent:
                    saveStatus === 'clean' && !inspectorScratch,
                  triggersAvailable,
                }}
                scope={{ apiClient, userId, workspace, workflowId }}
              />
            </>
          )
        }
        shortcuts={{
          open: chrome.shortcutsOpen,
          onOpenChange: chrome.onShortcutsOpenChange,
        }}
      />
      {canPropose ? (
        <DraftProposal
          handle={proposalHandle}
          open={chrome.proposalOpen}
          onOpenChange={chrome.onProposalOpenChange}
          finalFocus={proposalFinalFocus}
          graph={graph}
          onFix={chrome.onFix}
        />
      ) : null}
    </>
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
        actions={{
          cancel: { kind: 'close', label: 'Cancel', variant: 'ghost' },
          confirm: {
            label: 'Remove failure path',
            type: 'submit',
            variant: 'destructive',
            pendingLabel: 'Remove failure path',
            disabled: paused,
          },
        }}
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
