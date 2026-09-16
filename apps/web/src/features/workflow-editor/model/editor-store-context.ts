import { createContext, use } from 'react';
import { useStore } from 'zustand';
import type { EditorStore } from './editor.store';

export const EditorStoreContext = createContext<EditorStore | null>(null);

export function useEditorStore<Value>(
  selector: (state: ReturnType<EditorStore['getState']>) => Value,
): Value {
  const store = use(EditorStoreContext);
  if (store === null)
    throw new Error('useEditorStore must be used inside EditorProvider.');
  return useStore(store, selector);
}

export function useEditorStoreApi(): EditorStore {
  const store = use(EditorStoreContext);
  if (store === null)
    throw new Error('useEditorStoreApi must be used inside EditorProvider.');
  return store;
}
