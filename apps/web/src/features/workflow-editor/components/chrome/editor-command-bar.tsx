import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import type { ReactNode } from 'react';
import { WorkflowHubBar } from '@/features/workflows/hub.public';
import { HistoryControls } from './history-controls';
import { SaveState } from './save-state';
import { ShortcutSheet } from './shortcut-sheet';

/**
 * The Build tab's hub bar: the save state as a sentence under the name, then
 * undo/redo, shortcuts and the publish feature's commands on the right.
 */
export function EditorCommandBar({
  workspace,
  workflowId,
  workflow,
  shortcutsOpen,
  onShortcutsOpenChange,
  onRetrySave,
  onReviewConflict,
  onUndo,
  onRedo,
  commands,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;
  onRetrySave: () => void;
  onReviewConflict: () => void;
  onUndo: () => void;
  onRedo: () => void;
  commands: ReactNode;
}>) {
  return (
    <WorkflowHubBar
      workspace={workspace}
      workflowId={workflowId}
      workflow={workflow}
      activeTab="build"
      detail={<SaveState onRetry={onRetrySave} onReview={onReviewConflict} />}
      actions={
        <>
          <HistoryControls onUndo={onUndo} onRedo={onRedo} />
          <ShortcutSheet
            open={shortcutsOpen}
            onOpenChange={onShortcutsOpenChange}
          />
          {commands}
        </>
      }
    />
  );
}
