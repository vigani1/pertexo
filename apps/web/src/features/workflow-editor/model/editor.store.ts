import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { createStore } from 'zustand/vanilla';
import {
  emptyEditorHistory,
  recordHistory,
  redoHistory,
  undoHistory,
  type EditorHistory,
} from './editor-history';

type SaveStatus =
  'clean' | 'dirty' | 'saving' | 'conflict' | 'failed' | 'uncertain';

type EditorConflict = Readonly<{
  local: WorkflowGraphContract;
  remote: WorkflowGraphContract;
  remoteEtag: string;
  remoteRevision: number;
}>;

/** Consecutive live edits of one field within this window undo together. */
export const EDIT_COALESCE_WINDOW_MS = 2_000;

export type EditorState = Readonly<{
  graph: WorkflowGraphContract;
  etag: string;
  revision: number;
  /** Server time of the acknowledged draft, for "Saved 14:31". */
  savedAt: string | null;
  generation: number;
  /** The step shown in the inspector. */
  selectedNodeId: string | null;
  selectedNodeIds: readonly string[];
  selectedEdgeIds: readonly string[];
  /** The inspector holds an edit too incomplete to apply to the graph. */
  inspectorScratch: boolean;
  lastEdit: Readonly<{ key: string; at: number }> | null;
  history: EditorHistory;
  saveStatus: SaveStatus;
  saveError: string | null;
  conflict: EditorConflict | null;
}>;

export type EditorActions = Readonly<{
  transact: (
    next: WorkflowGraphContract,
    options?: Readonly<{ coalesceKey?: string }>,
  ) => void;
  selectNode: (nodeId: string | null) => void;
  selectNodes: (nodeIds: readonly string[]) => void;
  selectEdges: (edgeIds: readonly string[]) => void;
  setInspectorScratch: (scratch: boolean) => void;
  undo: () => void;
  redo: () => void;
  beginSave: () => void;
  acceptSave: (
    etag: string,
    revision: number,
    savedGeneration: number,
    savedAt?: string,
  ) => void;
  reportFailure: (message: string, uncertain: boolean) => void;
  reportConflict: (conflict: EditorConflict) => void;
  discardLocalAndUseRemote: () => void;
  acceptRemoteForReview: () => void;
  dismissConflictComparison: () => void;
}>;

export type EditorStore = ReturnType<typeof createEditorStore>;

export function createEditorStore(
  input: Readonly<{
    graph: WorkflowGraphContract;
    etag: string;
    revision: number;
    savedAt?: string;
  }>,
  clock: Readonly<{ now: () => number }> = { now: () => Date.now() },
) {
  return createStore<EditorState & EditorActions>((set, get) => ({
    graph: input.graph,
    etag: input.etag,
    revision: input.revision,
    savedAt: input.savedAt ?? null,
    generation: 0,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedEdgeIds: [],
    inspectorScratch: false,
    lastEdit: null,
    history: emptyEditorHistory,
    saveStatus: 'clean',
    saveError: null,
    conflict: null,
    transact: (next, options = {}) => {
      const current = get();
      if (next === current.graph || current.saveStatus === 'conflict') return;
      const at = clock.now();
      const coalesce =
        options.coalesceKey !== undefined &&
        current.lastEdit?.key === options.coalesceKey &&
        at - current.lastEdit.at < EDIT_COALESCE_WINDOW_MS;
      set({
        graph: next,
        generation: current.generation + 1,
        history: coalesce
          ? { past: current.history.past, future: [] }
          : recordHistory(current.history, current.graph),
        lastEdit:
          options.coalesceKey === undefined
            ? null
            : { key: options.coalesceKey, at },
        saveStatus: 'dirty',
        saveError: null,
        ...pruneSelection(next, current),
      });
    },
    selectNode: (selectedNodeId) => {
      const current = get();
      set({
        selectedNodeId,
        selectedNodeIds: selectedNodeId === null ? [] : [selectedNodeId],
        selectedEdgeIds: [],
        inspectorScratch:
          selectedNodeId === current.selectedNodeId && current.inspectorScratch,
      });
    },
    selectNodes: (selectedNodeIds) => {
      const current = get();
      const primary =
        selectedNodeIds.length === 1 ? (selectedNodeIds[0] ?? null) : null;
      set({
        selectedNodeIds,
        selectedNodeId: primary,
        inspectorScratch:
          primary === current.selectedNodeId && current.inspectorScratch,
      });
    },
    selectEdges: (selectedEdgeIds) => {
      set({ selectedEdgeIds });
    },
    setInspectorScratch: (inspectorScratch) => {
      if (get().inspectorScratch !== inspectorScratch)
        set({ inspectorScratch });
    },
    undo: () => {
      const current = get();
      if (current.saveStatus === 'conflict') return;
      const result = undoHistory(current.history, current.graph);
      if (result === null) return;
      set({
        graph: result.graph,
        history: result.history,
        generation: current.generation + 1,
        lastEdit: null,
        saveStatus: 'dirty',
        saveError: null,
        ...pruneSelection(result.graph, current),
      });
    },
    redo: () => {
      const current = get();
      if (current.saveStatus === 'conflict') return;
      const result = redoHistory(current.history, current.graph);
      if (result === null) return;
      set({
        graph: result.graph,
        history: result.history,
        generation: current.generation + 1,
        lastEdit: null,
        saveStatus: 'dirty',
        saveError: null,
        ...pruneSelection(result.graph, current),
      });
    },
    beginSave: () => {
      set({ saveStatus: 'saving', saveError: null });
    },
    acceptSave: (etag, revision, savedGeneration, savedAt) => {
      const current = get();
      set({
        etag,
        revision,
        savedAt: savedAt ?? current.savedAt,
        saveStatus: current.generation === savedGeneration ? 'clean' : 'dirty',
        saveError: null,
      });
    },
    reportFailure: (saveError, uncertain) => {
      set({ saveStatus: uncertain ? 'uncertain' : 'failed', saveError });
    },
    reportConflict: (conflict) => {
      set({ saveStatus: 'conflict', conflict, saveError: null });
    },
    discardLocalAndUseRemote: () => {
      const conflict = get().conflict;
      if (conflict === null) return;
      set({
        ...adoptRemote(conflict, get().generation),
        conflict: null,
      });
    },
    acceptRemoteForReview: () => {
      const conflict = get().conflict;
      if (conflict === null) return;
      set(adoptRemote(conflict, get().generation));
    },
    dismissConflictComparison: () => {
      if (get().saveStatus !== 'conflict') set({ conflict: null });
    },
  }));
}

function adoptRemote(conflict: EditorConflict, generation: number) {
  return {
    graph: conflict.remote,
    etag: conflict.remoteEtag,
    revision: conflict.remoteRevision,
    generation: generation + 1,
    history: emptyEditorHistory,
    lastEdit: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedEdgeIds: [],
    inspectorScratch: false,
    saveStatus: 'clean',
    saveError: null,
  } as const;
}

/** Drops selected nodes and edges that no longer exist in `graph`. */
function pruneSelection(
  graph: WorkflowGraphContract,
  current: Pick<
    EditorState,
    | 'selectedNodeId'
    | 'selectedNodeIds'
    | 'selectedEdgeIds'
    | 'inspectorScratch'
  >,
) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const selectedNodeIds = current.selectedNodeIds.filter((id) =>
    nodeIds.has(id),
  );
  const selectedEdgeIds = current.selectedEdgeIds.filter((id) =>
    edgeIds.has(id),
  );
  const selectedNodeId =
    current.selectedNodeId !== null && nodeIds.has(current.selectedNodeId)
      ? current.selectedNodeId
      : null;
  return {
    selectedNodeId,
    inspectorScratch:
      selectedNodeId === current.selectedNodeId && current.inspectorScratch,
    selectedNodeIds:
      selectedNodeIds.length === current.selectedNodeIds.length
        ? current.selectedNodeIds
        : selectedNodeIds,
    selectedEdgeIds:
      selectedEdgeIds.length === current.selectedEdgeIds.length
        ? current.selectedEdgeIds
        : selectedEdgeIds,
  };
}
