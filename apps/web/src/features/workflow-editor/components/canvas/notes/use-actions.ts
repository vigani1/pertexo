import { useNotifications } from '@/components/ui/use-notifications';
import {
  WORKFLOW_NOTE_LIMITS,
  type WorkflowNote,
} from '@pertexo/workflow-model';
import { useEditorStoreApi } from '../../../model/state/context';
import {
  addWorkflowNote,
  removeWorkflowNote,
  updateWorkflowNote,
} from '../../../model/notes/commands';

export function useNoteActions() {
  const store = useEditorStoreApi();
  const notifications = useNotifications();
  return {
    update: (note: WorkflowNote) => {
      const state = store.getState();
      state.transact(updateWorkflowNote(state.graph, note));
    },
    add: (note: WorkflowNote): boolean => {
      const state = store.getState(),
        graph = addWorkflowNote(state.graph, note);
      if (graph === null) {
        notifications.error({
          title: `The canvas has ${String(WORKFLOW_NOTE_LIMITS.count)} notes`,
          description: 'Remove a note before adding another.',
        });
        return false;
      }
      // Selecting away would unmount an unfinished inspector edit and lose it.
      if (!state.inspectorScratch) state.selectNodes([]);
      state.transact(graph);
      return true;
    },
    remove: (note: WorkflowNote) => {
      const state = store.getState(),
        graph = removeWorkflowNote(state.graph, note.id);
      if (graph === state.graph) return;
      const index =
        state.graph.notes?.findIndex((value) => value.id === note.id) ?? 0;
      state.transact(graph);
      const generation = store.getState().generation;
      notifications.undo({
        title: 'Note deleted',
        onUndo: () => {
          const latest = store.getState();
          if (latest.generation === generation) {
            latest.undo();
            return;
          }
          const restored = addWorkflowNote(latest.graph, note);
          if (restored === null) {
            notifications.error({
              title: `The canvas has ${String(WORKFLOW_NOTE_LIMITS.count)} notes`,
              description: 'Remove a note before restoring this one.',
            });
            return;
          }
          if (restored === latest.graph) return;
          const notes = [...(latest.graph.notes ?? [])];
          notes.splice(index, 0, note);
          latest.transact({ ...restored, notes });
        },
      });
    },
  };
}
