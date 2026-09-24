import { useCallback, useEffect, useRef } from 'react';
import type { EditorStore } from './model/editor.store';
import {
  createSaveCoordinator,
  type SaveCoordinatorTransport,
} from './model/save-coordinator';

export function useSaveCoordinator(
  store: EditorStore,
  transport: SaveCoordinatorTransport,
  enabled: boolean,
) {
  const coordinatorRef = useRef<ReturnType<
    typeof createSaveCoordinator
  > | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const coordinator = createSaveCoordinator(store, transport);
    coordinatorRef.current = coordinator;
    const unsubscribe = store.subscribe((state, previous) => {
      if (
        state.generation !== previous.generation &&
        state.saveStatus === 'dirty'
      )
        coordinator.schedule();
    });
    return () => {
      unsubscribe();
      coordinator.destroy();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [enabled, store, transport]);

  return useCallback(async () => {
    await coordinatorRef.current?.flush();
  }, []);
}
