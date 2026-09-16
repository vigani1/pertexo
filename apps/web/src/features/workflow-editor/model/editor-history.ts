import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

const EDITOR_HISTORY_LIMIT = 100;

export type EditorHistory = Readonly<{
  past: readonly WorkflowGraphContract[];
  future: readonly WorkflowGraphContract[];
}>;

export const emptyEditorHistory: EditorHistory = Object.freeze({
  past: Object.freeze([]),
  future: Object.freeze([]),
});

export function recordHistory(
  history: EditorHistory,
  previous: WorkflowGraphContract,
): EditorHistory {
  return {
    past: [...history.past, previous].slice(-EDITOR_HISTORY_LIMIT),
    future: [],
  };
}

export function undoHistory(
  history: EditorHistory,
  current: WorkflowGraphContract,
): Readonly<{ graph: WorkflowGraphContract; history: EditorHistory }> | null {
  const graph = history.past.at(-1);
  if (graph === undefined) return null;
  return {
    graph,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, EDITOR_HISTORY_LIMIT),
    },
  };
}

export function redoHistory(
  history: EditorHistory,
  current: WorkflowGraphContract,
): Readonly<{ graph: WorkflowGraphContract; history: EditorHistory }> | null {
  const graph = history.future[0];
  if (graph === undefined) return null;
  return {
    graph,
    history: {
      past: [...history.past, current].slice(-EDITOR_HISTORY_LIMIT),
      future: history.future.slice(1),
    },
  };
}
