import { useCallback, useEffect, useRef } from 'react';
import type { EditorStore } from '../model/state/store';
import {
  createSaveCoordinator,
  type SaveCoordinatorTransport,
} from '../model/persistence/save-coordinator';

export function useSaveCoordinator({
  store,
  transport,
  enabled,
}: Readonly<{
  store: EditorStore;
  transport: SaveCoordinatorTransport;
  enabled: boolean;
}>) {
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
    // A save that went unconfirmed while offline goes again on reconnect.
    const resume = () => {
      if (store.getState().saveStatus === 'uncertain') void coordinator.flush();
    };
    window.addEventListener('online', resume);
    return () => {
      window.removeEventListener('online', resume);
      unsubscribe();
      coordinator.destroy();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [enabled, store, transport]);

  return useCallback(async () => {
    await coordinatorRef.current?.flush();
  }, []);
}
