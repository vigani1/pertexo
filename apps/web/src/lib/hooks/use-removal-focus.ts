import { useEffect, useRef } from 'react';

/**
 * Keeps keyboard focus in a list whose rows each have a Remove button: the
 * focused button leaves with its row, so the next row's button takes focus,
 * else the previous row's, else `fallback` (the control that adds rows).
 */
export function useRemovalFocus<Fallback extends HTMLElement>() {
  const buttons = useRef(new Map<string, HTMLElement>());
  const fallback = useRef<Fallback>(null);
  // A row key, null for the fallback, undefined when nothing was removed.
  const pending = useRef<string | null | undefined>(undefined);

  // After every render: the removal has rendered by the time this runs.
  useEffect(() => {
    const target = pending.current;
    if (target === undefined) return;
    pending.current = undefined;
    (target === null ? fallback.current : buttons.current.get(target))?.focus();
  });

  return {
    fallback,
    /** The ref for one row's Remove button. */
    removeButton: (key: string) => (element: HTMLElement | null) => {
      if (element === null) buttons.current.delete(key);
      else buttons.current.set(key, element);
    },
    /** Call as a row is removed, with every row's key in order. */
    removing: (keys: readonly string[], key: string) => {
      const index = keys.indexOf(key);
      pending.current = keys[index + 1] ?? keys[index - 1] ?? null;
    },
  } as const;
}
