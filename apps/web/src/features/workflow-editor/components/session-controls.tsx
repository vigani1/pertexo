import { useEditorSession } from '../model/state/context';

import type { ReactNode } from 'react';
import { SparklesIcon } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { cn } from '@/lib/class-names';
import type { WorkflowGraphContract } from '@pertexo/contracts';

import {
  WorkflowCommandActions,
  IssuesMenuItem,
} from '@/features/workflow-publish/workflow-publish-views.public';
import {
  emptyDraftHint,
  type useWorkflowCommandSession,
} from '@/features/workflow-publish/public';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { EditorCommandBar } from './chrome/editor-command-bar';
import { ASSISTANT_TRIGGER_ATTRIBUTE } from '../hooks/use-assistant-opening';
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
  const canPropose = !paused && editing.canUpdate;
  const emptyHint = emptyDraftHint({ graph, triggersAvailable });
  const hasCleanCheck =
    !issues.checking &&
    !issues.stale &&
    issues.error === undefined &&
    issues.groups?.length === 0 &&
    emptyHint === undefined;

  return (
    <>
      <EditorCommandBar
        presence={headerPresence}
        moreRef={chrome.overflowRef}
        phoneMenuItems={
          canPropose ? (
            <DropdownMenuItem onClick={chrome.openProposal}>
              <SparklesIcon aria-hidden="true" />
              Ask the assistant
            </DropdownMenuItem>
          ) : undefined
        }
        secondaryMenuItems={
          paused ? null : (
            <IssuesMenuItem
              state={issues}
              emptyHint={emptyHint}
              open={chrome.issuesOpen}
              onOpenChange={chrome.onIssuesOpenChange}
            />
          )
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
              <StatusMark
                tone="success"
                className={cn('max-xl:hidden', !hasCleanCheck && 'invisible')}
              >
                No issues
              </StatusMark>
              {canPropose ? (
                <Button
                  {...{ [ASSISTANT_TRIGGER_ATTRIBUTE]: '' }}
                  variant="outline"
                  size="sm"
                  className="max-sm:hidden"
                  aria-label="Ask the assistant"
                  onClick={chrome.openProposal}
                >
                  <SparklesIcon aria-hidden="true" />
                  Ask the assistant
                </Button>
              ) : null}
              <WorkflowCommandActions
                renderFeedback={chrome.renderFeedback}
                commandSession={commandSession}
                renderTestAction={chrome.renderTestAction}
                onPublished={(receipt) => {
                  if (!receipt.reused) effects.weaveIn();
                }}
                validation={{
                  issues,
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
