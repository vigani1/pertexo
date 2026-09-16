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

export type EditorState = Readonly<{
  graph: WorkflowGraphContract;
  etag: string;
  revision: number;
  generation: number;
  selectedNodeId: string | null;
  history: EditorHistory;
  saveStatus: SaveStatus;
  saveError: string | null;
  conflict: EditorConflict | null;
}>;

export type EditorActions = Readonly<{
  transact: (next: WorkflowGraphContract) => void;
  selectNode: (nodeId: string | null) => void;
  undo: () => void;
  redo: () => void;
  beginSave: () => void;
  acceptSave: (etag: string, revision: number, savedGeneration: number) => void;
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
  }>,
) {
  return createStore<EditorState & EditorActions>((set, get) => ({
    graph: input.graph,
    etag: input.etag,
    revision: input.revision,
    generation: 0,
    selectedNodeId: null,
    history: emptyEditorHistory,
    saveStatus: 'clean',
    saveError: null,
    conflict: null,
    transact: (next) => {
      const current = get();
      if (next === current.graph || current.saveStatus === 'conflict') return;
      set({
        graph: next,
        generation: current.generation + 1,
        history: recordHistory(current.history, current.graph),
        saveStatus: 'dirty',
        saveError: null,
      });
    },
    selectNode: (selectedNodeId) => {
      set({ selectedNodeId });
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
        saveStatus: 'dirty',
        saveError: null,
        selectedNodeId: selectedNodeStillExists(
          result.graph.nodes,
          current.selectedNodeId,
        ),
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
        saveStatus: 'dirty',
        saveError: null,
        selectedNodeId: selectedNodeStillExists(
          result.graph.nodes,
          current.selectedNodeId,
        ),
      });
    },
    beginSave: () => {
      set({ saveStatus: 'saving', saveError: null });
    },
    acceptSave: (etag, revision, savedGeneration) => {
      const current = get();
      set({
        etag,
        revision,
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
        graph: conflict.remote,
        etag: conflict.remoteEtag,
        revision: conflict.remoteRevision,
        generation: get().generation + 1,
        history: emptyEditorHistory,
        selectedNodeId: null,
        saveStatus: 'clean',
        saveError: null,
        conflict: null,
      });
    },
    acceptRemoteForReview: () => {
      const current = get();
      if (current.conflict === null) return;
      set({
        graph: current.conflict.remote,
        etag: current.conflict.remoteEtag,
        revision: current.conflict.remoteRevision,
        generation: current.generation + 1,
        history: emptyEditorHistory,
        selectedNodeId: null,
        saveStatus: 'clean',
        saveError: null,
      });
    },
    dismissConflictComparison: () => {
      if (get().saveStatus !== 'conflict') set({ conflict: null });
    },
  }));
}

function selectedNodeStillExists(
  nodes: WorkflowGraphContract['nodes'],
  selectedNodeId: string | null,
): string | null {
  return selectedNodeId !== null &&
    nodes.some((node) => node.id === selectedNodeId)
    ? selectedNodeId
    : null;
}
