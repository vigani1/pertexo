import type {
  NodeDefinitionCatalogItem,
  WorkflowNodeRunSummary,
} from '@pertexo/contracts';
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { WorkflowIssuesView } from '@/features/workflow-publish/public';
import type { useEditorStoreApi } from '../model/state/context';
import type { useCanvasEffects } from '../hooks/use-canvas-effects';
import type { useEditorActions } from '../hooks/use-editor-actions';
import type { MobilePanel } from '../hooks/use-inspector-navigation';
import { useQuickAdd } from './add-step/use-quick-add';
import { useStepPlacement } from './add-step/use-step-placement';

/** The add-step lens's fold and its search field, which "/" focuses. */
export function useAddStepFold({
  editable,
  setMobilePanel,
}: Readonly<{
  editable: boolean;
  setMobilePanel: (panel: MobilePanel) => void;
}>) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  return {
    searchRef,
    collapsed,
    toggle: () => {
      setCollapsed((current) => !current);
    },
    focus: () => {
      if (!editable) return;
      flushSync(() => {
        setCollapsed(false);
        setMobilePanel('add');
      });
      searchRef.current?.focus();
    },
  } as const;
}

/**
 * What the canvas draws over the steps: issue counts, a passed test's path
 * and output size, and the publish weave. A valid step says nothing: a
 * mark that came and went with every check made each card grow and shrink.
 */
export function useCanvasOverlays(
  issues: WorkflowIssuesView,
  effects: ReturnType<typeof useCanvasEffects>,
  testStatuses:
    ReadonlyMap<string, WorkflowNodeRunSummary['status']> | undefined,
) {
  return useMemo(
    () => ({
      issuesByNode: issues.countsByNode,
      flowingEdgeIds: effects.flowingEdgeIds,
      weaveOrder: effects.weaveOrder,
      testOutputBytes: effects.testOutputBytes,
      testStatuses,
    }),
    [
      testStatuses,
      effects.flowingEdgeIds,
      effects.testOutputBytes,
      effects.weaveOrder,
      issues.countsByNode,
    ],
  );
}

/**
 * How new steps are added: placed from the add-step lens or a drag, or
 * quick-added after a step or into a For each body. A new step is selected
 * unless the inspector holds an unfinished edit.
 */
export function useStepAdding({
  store,
  definitions,
  canvasRef,
  editable,
}: Readonly<{
  store: ReturnType<typeof useEditorStoreApi>;
  definitions: readonly NodeDefinitionCatalogItem[];
  canvasRef: RefObject<HTMLDivElement | null>;
  editable: boolean;
}>) {
  const placement = useStepPlacement({
    store,
    definitions,
    canvasRef,
    onPlaced: (nodeId) => {
      if (!store.getState().inspectorScratch)
        store.getState().selectNode(nodeId);
    },
  });
  const quickAdd = useQuickAdd({
    store,
    definitions,
    onAdd: placement.addFromQuickAdd,
  });
  return {
    placement,
    quickAdd,
    addAfter: (nodeId: string, returnFocus: HTMLElement | null) => {
      if (editable) quickAdd.openAfter(nodeId, returnFocus);
    },
    addToBody: (loopId: string, opener: HTMLElement) => {
      if (editable) quickAdd.openInBody(loopId, opener);
    },
  } as const;
}

/** Canvas selection commands, all routed through the guarded request. */
export function useSelectionCommands({
  store,
  request,
  editable,
}: Readonly<{
  store: ReturnType<typeof useEditorStoreApi>;
  request: ReturnType<typeof useEditorActions>['request'];
  editable: boolean;
}>) {
  const selectNodes = useCallback(
    (nodeIds: readonly string[]) => {
      request({ kind: 'select', nodeIds });
    },
    [request],
  );
  const removeEdge = useCallback(
    (edgeId: string) => {
      request({ kind: 'delete', nodeIds: [], edgeIds: [edgeId] });
    },
    [request],
  );
  function deleteSelection() {
    const state = store.getState();
    if (editable)
      request({
        kind: 'delete',
        nodeIds: state.selectedNodeIds,
        edgeIds: state.selectedEdgeIds,
      });
  }
  function duplicateSelection() {
    if (editable)
      request({ kind: 'duplicate', nodeIds: store.getState().selectedNodeIds });
  }
  return { selectNodes, removeEdge, deleteSelection, duplicateSelection };
}
