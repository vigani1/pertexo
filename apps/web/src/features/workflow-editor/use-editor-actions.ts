import { useCallback, useState } from 'react';
import { useNotifications } from '@/components/ui/use-notifications';
import type { EditorStore } from './model/editor.store';
import { stepTitle } from './model/graph-adapter';
import {
  duplicateWorkflowNodes,
  removeWorkflowElements,
  restoreWorkflowElements,
  type RemovedElements,
} from './model/graph-commands';

export type EditorFocusTarget = Readonly<{
  nodeId: string;
  fieldKey?: string;
  mappingKey?: string;
}>;

export type EditorAction =
  | Readonly<{
      kind: 'select';
      nodeIds: readonly string[];
      focusTarget?: EditorFocusTarget;
    }>
  | Readonly<{ kind: 'undo' | 'redo' }>
  | Readonly<{
      kind: 'delete';
      nodeIds: readonly string[];
      edgeIds: readonly string[];
    }>
  | Readonly<{ kind: 'duplicate'; nodeIds: readonly string[] }>;

/**
 * Arbitrates editor commands against an unfinished inspector edit. Commands
 * that would replace or rewrite the step being edited wait for the person
 * to discard the edit or stay; everything else runs immediately.
 */
export function useEditorActions({
  store,
  isPaused,
}: Readonly<{ store: EditorStore; isPaused: () => boolean }>) {
  const notifications = useNotifications();
  const [pendingAction, setPendingAction] = useState<EditorAction>();
  const [scratchVersion, setScratchVersion] = useState(0);
  const [focusTarget, setFocusTarget] = useState<
    EditorFocusTarget & Readonly<{ requestId: number }>
  >();

  const perform = useCallback(
    (action: EditorAction) => {
      const state = store.getState();
      switch (action.kind) {
        case 'select':
          state.selectNodes(action.nodeIds);
          if (action.focusTarget !== undefined) {
            const target = action.focusTarget;
            setFocusTarget((current) => ({
              ...target,
              requestId: (current?.requestId ?? 0) + 1,
            }));
          }
          return;
        case 'undo':
          state.undo();
          return;
        case 'redo':
          state.redo();
          return;
        case 'duplicate': {
          const result = duplicateWorkflowNodes(state.graph, action.nodeIds);
          if (result.nodeIds.length === 0) return;
          state.transact(result.graph);
          if (!state.inspectorScratch) state.selectNodes(result.nodeIds);
          return;
        }
        case 'delete': {
          const result = removeWorkflowElements(state.graph, action);
          if (result.graph === state.graph) return;
          state.transact(result.graph);
          const generation = store.getState().generation;
          notifications.undo({
            title: removalTitle(result.removed),
            onUndo: () => {
              const latest = store.getState();
              if (latest.generation === generation) latest.undo();
              else
                latest.transact(
                  restoreWorkflowElements(latest.graph, result.removed),
                );
            },
          });
          return;
        }
      }
    },
    [notifications, store],
  );

  const request = useCallback(
    (action: EditorAction) => {
      if (isPaused()) return;
      const state = store.getState();
      if (action.kind === 'select' && isCurrentSelection(action, state)) {
        if (action.focusTarget !== undefined) perform(action);
        return;
      }
      if (state.inspectorScratch && replacesInspectedStep(action, state))
        setPendingAction(action);
      else perform(action);
    },
    [isPaused, perform, store],
  );

  const discardAndContinue = useCallback(() => {
    if (pendingAction === undefined) return;
    setPendingAction(undefined);
    setScratchVersion((current) => current + 1);
    store.getState().setInspectorScratch(false);
    perform(pendingAction);
  }, [pendingAction, perform, store]);

  const stay = useCallback(() => {
    setPendingAction(undefined);
  }, []);

  /** Throws away inspector scratch without another command. */
  const discardScratch = useCallback(() => {
    setScratchVersion((current) => current + 1);
    store.getState().setInspectorScratch(false);
  }, [store]);

  return {
    request,
    pendingAction,
    discardAndContinue,
    stay,
    discardScratch,
    scratchVersion,
    focusTarget,
  } as const;
}

function isCurrentSelection(
  action: Extract<EditorAction, { kind: 'select' }>,
  state: ReturnType<EditorStore['getState']>,
): boolean {
  const selected = new Set(state.selectedNodeIds);
  return (
    action.nodeIds.length === selected.size &&
    action.nodeIds.every((id) => selected.has(id))
  );
}

function replacesInspectedStep(
  action: EditorAction,
  state: ReturnType<EditorStore['getState']>,
): boolean {
  switch (action.kind) {
    case 'select': {
      const primary =
        action.nodeIds.length === 1 ? (action.nodeIds[0] ?? null) : null;
      return primary !== state.selectedNodeId;
    }
    case 'undo':
    case 'redo':
      return true;
    case 'delete':
      return (
        state.selectedNodeId !== null &&
        action.nodeIds.includes(state.selectedNodeId)
      );
    case 'duplicate':
      return false;
  }
}

function removalTitle(removed: RemovedElements): string {
  const [onlyNode] = removed.nodes;
  if (removed.nodes.length === 1 && onlyNode !== undefined)
    return `Deleted “${stepTitle(onlyNode)}”`;
  if (removed.nodes.length > 1)
    return `Deleted ${String(removed.nodes.length)} steps`;
  return removed.edges.length === 1
    ? 'Connection removed'
    : `Removed ${String(removed.edges.length)} connections`;
}
