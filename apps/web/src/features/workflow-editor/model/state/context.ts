import { createContext, use } from 'react';
import { useStore } from 'zustand';
import type { EditorStore } from './store';
import type { EditorSession } from './session';

export const EditorStoreContext = createContext<Readonly<{
  store: EditorStore;
  session?: EditorSession;
}> | null>(null);

export function useEditorStore<Value>(
  selector: (state: ReturnType<EditorStore['getState']>) => Value,
): Value {
  const scope = use(EditorStoreContext);
  if (scope === null)
    throw new Error('useEditorStore must be used inside EditorProvider.');
  return useStore(scope.store, selector);
}

export function useEditorStoreApi(): EditorStore {
  const scope = use(EditorStoreContext);
  if (scope === null)
    throw new Error('useEditorStoreApi must be used inside EditorProvider.');
  return scope.store;
}

export function useEditorSession(): EditorSession {
  const scope = use(EditorStoreContext);
  if (scope?.session === undefined)
    throw new Error(
      'useEditorSession must be used inside EditorSessionProvider.',
    );
  return scope.session;
}
