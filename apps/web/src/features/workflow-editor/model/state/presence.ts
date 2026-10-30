import type { EditorState, EditorStore } from './store';
export type EditorPresenceSource = Readonly<{
  subscribe: (
    listener: (
      state: Readonly<{
        editing: boolean;
        dirty: boolean;
        baseRevision: number | null;
      }>,
    ) => void,
  ) => () => void;
}>;
/** A metadata-only subscription; the draft and scratch never leave their owner. */
export function editorPresenceSource({
  store,
  editing,
}: Readonly<{ store: EditorStore; editing: boolean }>): EditorPresenceSource {
  return {
    subscribe(listener) {
      const report = (state: EditorState) => {
        listener({
          editing,
          dirty:
            editing &&
            (state.save.status !== 'clean' || state.inspectorScratch),
          baseRevision: state.revision,
        });
      };
      report(store.getState());
      return store.subscribe(report);
    },
  };
}
