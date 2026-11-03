import type { WorkflowGraphContract } from '@pertexo/contracts';
import { createStore } from 'zustand/vanilla';
import {
  emptyEditorHistory,
  recordHistory,
  redoHistory,
  undoHistory,
  type EditorHistory,
} from '../persistence/editor-history';
import { indexGraph } from '../graph/scopes';

type EditorConflict = Readonly<{
  local: WorkflowGraphContract;
  remote: WorkflowGraphContract;
  remoteEtag: string;
  remoteRevision: number;
}>;

/** Where saving stands; a failure always has its reason, a conflict both drafts. */
type SaveState =
  | Readonly<{ status: 'clean' | 'dirty' | 'saving' }>
  | Readonly<{ status: 'failed' | 'uncertain'; error: string }>
  | Readonly<{ status: 'conflict'; conflict: EditorConflict }>;

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
  save: SaveState;
  /** A resolved conflict's drafts, kept so people can still compare them. */
}>;

/** The unresolved conflict, if there is one. */
export function shownConflict(
  state: Pick<EditorState, 'save'>,
): EditorConflict | null {
  return state.save.status === 'conflict' ? state.save.conflict : null;
}

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
  /** Sends the same save again, because the last one never arrived. */
  requeueSave: () => void;
  acceptSave: (
    etag: string,
    revision: number,
    savedGeneration: number,
    savedAt?: string,
  ) => void;
  reportFailure: (message: string, uncertain: boolean) => void;
  reportConflict: (conflict: EditorConflict) => void;
  discardLocalAndUseRemote: () => void;
  /** Saves this graph over theirs, from their revision. */
  keepMine: () => void;
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
  return createStore<EditorState & EditorActions>((set, get) => {
    /** Undo or redo: the graph moves through history and is saved again. */
    const travel = (step: typeof undoHistory) => {
      const current = get();
      if (current.save.status === 'conflict') return;
      const result = step(current.history, current.graph);
      if (result === null) return;
      set({
        graph: result.graph,
        history: result.history,
        generation: current.generation + 1,
        lastEdit: null,
        save: { status: 'dirty' },
        ...pruneSelection(result.graph, current),
      });
    };
    return {
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
      save: { status: 'clean' },
      transact: (next, options = {}) => {
        const current = get();
        if (next === current.graph || current.save.status === 'conflict')
          return;
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
          save: { status: 'dirty' },
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
            selectedNodeId === current.selectedNodeId &&
            current.inspectorScratch,
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
        travel(undoHistory);
      },
      redo: () => {
        travel(redoHistory);
      },
      beginSave: () => {
        set({ save: { status: 'saving' } });
      },
      requeueSave: () => {
        set({ save: { status: 'dirty' } });
      },
      acceptSave: (etag, revision, savedGeneration, savedAt) => {
        const current = get();
        set({
          etag,
          revision,
          savedAt: savedAt ?? current.savedAt,
          save: {
            status: current.generation === savedGeneration ? 'clean' : 'dirty',
          },
        });
      },
      reportFailure: (error, uncertain) => {
        set({ save: { status: uncertain ? 'uncertain' : 'failed', error } });
      },
      reportConflict: (conflict) => {
        set({ save: { status: 'conflict', conflict } });
      },
      discardLocalAndUseRemote: () => {
        const conflict = shownConflict(get());
        if (conflict === null) return;
        set(adoptRemote(conflict, get().generation));
      },
      keepMine: () => {
        const conflict = shownConflict(get());
        if (conflict === null) return;
        set({
          etag: conflict.remoteEtag,
          revision: conflict.remoteRevision,
          generation: get().generation + 1,
          save: { status: 'dirty' },
        });
      },
    };
  });
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
    save: { status: 'clean' },
  } as const;
}

/** Drops selected steps and links that no longer exist anywhere. */
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
  const { nodes: nodeIds, edges: edgeIds } = indexGraph(graph);
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
