import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { useRef, type ReactNode } from 'react';
import { WorkflowHubBar } from '@/features/workflows/hub.public';
import { PatternGlyph } from '@/features/workflows/shape.public';
import type { ApiClient } from '@/lib/api/client';
import { useEditorStore } from '../../model/editor-store-context';
import { CompactHistoryMenu, HistoryControls } from './history-controls';
import { LiveVersion } from './live-version';
import { SaveState } from './save-state';
import { ShortcutSheet } from './shortcut-sheet';

/**
 * The Build tab's hub bar: the draft's pattern glyph before the name, the
 * live version and save state as a sentence under it, then undo/redo,
 * shortcuts and the publish feature's commands on the right. Below 640px,
 * undo, redo and shortcuts fold into ⋯ so Run and Publish always fit.
 */
export function EditorCommandBar({
  apiClient,
  userId,
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
  apiClient: ApiClient;
  userId: string;
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
  const graph = useEditorStore((state) => state.graph);
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <WorkflowHubBar
      apiClient={apiClient}
      userId={userId}
      workspace={workspace}
      workflowId={workflowId}
      workflow={workflow}
      activeTab="build"
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
          <CompactHistoryMenu
            triggerRef={moreRef}
            className="sm:hidden"
            onUndo={onUndo}
            onRedo={onRedo}
            onShowShortcuts={() => {
              onShortcutsOpenChange(true);
            }}
          />
          {commands}
        </>
      }
    />
  );
}
