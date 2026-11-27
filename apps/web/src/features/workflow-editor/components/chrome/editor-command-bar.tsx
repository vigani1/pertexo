import type { ReactNode, RefObject } from 'react';
import { BracesIcon } from 'lucide-react';
import { DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  WorkflowHubBar,
  PatternGlyph,
} from '@/features/workflows/workflows-views.public';

import { useEditorStore, useEditorSession } from '../../model/state/context';
import { HistoryMenuItems } from './history-controls';
import { LiveVersion } from './live-version';
import { SaveState } from './save-state';
import { ShortcutSheet } from './shortcut-sheet';
import { DeclarationDialog } from '../callable/declaration-dialog';

/** Build keeps draft state and primary commands in the hub. */
export function EditorCommandBar({
  shortcuts,
  secondaryMenuItems,
  moreRef,
  onRetrySave,
  onReviewConflict,
  onUndo,
  onRedo,
  commands,
  presence,
}: Readonly<{
  shortcuts: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  secondaryMenuItems: ReactNode;
  moreRef: RefObject<HTMLButtonElement | null>;
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
    (state) => state.save.status !== 'clean' || state.inspectorScratch,
  );
  const contractBlocked = useEditorStore((state) => state.inspectorScratch);
  return (
    <DeclarationDialog
      editable={!paused && workspace.capabilities.includes('workflow:update')}
      finalFocus={() => moreRef.current ?? true}
    >
      <WorkflowHubBar
        workflow={workflow}
        activeTab="build"
        duplicateBlocked={duplicateBlocked}
        overflowRef={moreRef}
        slots={{
          presence,
          overflowActions: (
            <>
              <DialogTrigger
                render={<DropdownMenuItem />}
                disabled={contractBlocked}
                aria-label="Workflow contract"
              >
                <BracesIcon aria-hidden="true" />
                Contract
              </DialogTrigger>
              {secondaryMenuItems}
              <HistoryMenuItems
                onUndo={onUndo}
                onRedo={onRedo}
                onShowShortcuts={() => {
                  onShortcutsOpenChange(true);
                }}
              />
            </>
          ),
          glyph: (
            <PatternGlyph
              graph={graph}
              muted={(workflow?.publishedVersionId ?? null) === null}
              className="hidden sm:block"
            />
          ),
          detail: (
            <>
              <LiveVersion
                apiClient={apiClient}
                userId={userId}
                workspaceId={workspace.id}
                workflow={workflow}
              />
              <SaveState onRetry={onRetrySave} onReview={onReviewConflict} />
            </>
          ),
          actions: (
            <>
              <ShortcutSheet
                open={shortcutsOpen}
                onOpenChange={onShortcutsOpenChange}
                fallbackAnchor={moreRef}
              />
              {commands}
            </>
          ),
        }}
        scope={{
          apiClient,
          userId,
          workspace,
          workflowId,
        }}
      />
    </DeclarationDialog>
  );
}
