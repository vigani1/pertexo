import { useRef, type ReactNode } from 'react';
import { BracesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { WorkflowHubBar } from '@/features/workflows/hub.public';
import { PatternGlyph } from '@/features/workflows/shape.public';

import { useEditorStore, useEditorSession } from '../../model/state/context';
import { HistoryMenuItems, HistoryControls } from './history-controls';
import { LiveVersion } from './live-version';
import { SaveState } from './save-state';
import { ShortcutSheet } from './shortcut-sheet';
import { DeclarationDialog } from '../callable/declaration-dialog';

/**
 * The Build tab's hub bar: the draft's pattern glyph before the name, the
 * live version and save state as a sentence under it, then undo/redo,
 * shortcuts and the publish feature's commands on the right. Below 640px,
 * undo, redo and shortcuts fold into ⋯ so Run and Publish always fit.
 */
export function EditorCommandBar({
  shortcuts,
  testMenuItems,
  onRetrySave,
  onReviewConflict,
  onUndo,
  onRedo,
  commands,
  presence,
}: Readonly<{
  shortcuts: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  testMenuItems: ReactNode;
  onRetrySave: () => void;
  onReviewConflict: () => void;
  onUndo: () => void;
  onRedo: () => void;
  commands: ReactNode;
  presence?: ReactNode;
}>) {
  const { scope, editing } = useEditorSession();
  const { apiClient, userId, workspace, workflowId } = scope;
  const { workflow, paused } = editing;
  const { open: shortcutsOpen, onOpenChange: onShortcutsOpenChange } =
    shortcuts;
  const graph = useEditorStore((state) => state.graph);
  const duplicateBlocked = useEditorStore(
    (state) =>
      state.saveStatus !== 'clean' ||
      state.inspectorScratch ||
      state.conflict !== null,
  );
  const moreRef = useRef<HTMLButtonElement>(null);
  const contractRef = useRef<HTMLButtonElement>(null);
  const contractBlocked = useEditorStore((state) => state.inspectorScratch);
  // The contract opens from ⋯ only where its own button is hidden; there the
  // menu item is gone once the dialog closes, so focus returns to ⋯.
  function finalFocus() {
    const inline = contractRef.current;
    if (inline !== null && inline.getClientRects().length > 0) return true;
    const more = moreRef.current;
    return more !== null && more.getClientRects().length > 0 ? more : true;
  }
  return (
    <DeclarationDialog
      editable={!paused && workspace.capabilities.includes('workflow:update')}
      finalFocus={finalFocus}
    >
      <WorkflowHubBar
        apiClient={apiClient}
        userId={userId}
        workspace={workspace}
        workflowId={workflowId}
        workflow={workflow}
        activeTab="build"
        presence={presence}
        duplicateBlocked={duplicateBlocked}
        overflowRef={moreRef}
        mobileActions={
          <>
            <DialogTrigger
              render={<DropdownMenuItem />}
              disabled={contractBlocked}
              aria-label="Workflow contract"
            >
              <BracesIcon aria-hidden="true" />
              Contract
            </DialogTrigger>
            {testMenuItems}
            <HistoryMenuItems
              onUndo={onUndo}
              onRedo={onRedo}
              onShowShortcuts={() => {
                onShortcutsOpenChange(true);
              }}
            />
          </>
        }
        glyph={
          <PatternGlyph
            graph={graph}
            muted={(workflow?.publishedVersionId ?? null) === null}
            className="hidden sm:block"
          />
        }
        detail={
          <>
            <LiveVersion
              apiClient={apiClient}
              userId={userId}
              workspaceId={workspace.id}
              workflow={workflow}
            />
            <SaveState onRetry={onRetrySave} onReview={onReviewConflict} />
          </>
        }
        actions={
          <>
            <DialogTrigger
              ref={contractRef}
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="hidden sm:inline-flex"
                />
              }
              disabled={contractBlocked}
              aria-label="Workflow contract"
            >
              <BracesIcon aria-hidden="true" />
              Contract
            </DialogTrigger>
            <HistoryControls
              onUndo={onUndo}
              onRedo={onRedo}
              className="hidden sm:flex"
            />
            <ShortcutSheet
              open={shortcutsOpen}
              onOpenChange={onShortcutsOpenChange}
              triggerClassName="hidden sm:inline-flex"
              fallbackAnchor={moreRef}
            />
            {commands}
          </>
        }
      />
    </DeclarationDialog>
  );
}
