import { useEffect, useEffectEvent } from 'react';

function ignoresShortcuts(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null
  );
}

/**
 * List keys: `/` focuses the name filter, `N` starts a new workflow. Both
 * stay out of the way while typing or inside a dialog or menu.
 */
export function useListShortcuts({
  onFocusFilter,
  onCreate,
}: Readonly<{
  onFocusFilter: () => void;
  onCreate: (() => void) | undefined;
}>) {
  const focusFilter = useEffectEvent(onFocusFilter);
  const create = useEffectEvent((): boolean => {
    if (onCreate === undefined) return false;
    onCreate();
    return true;
  });
  useEffect(() => {
    function listen(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        ignoresShortcuts(event.target)
      )
        return;
      if (event.key === '/') {
        event.preventDefault();
        focusFilter();
      } else if (event.key.toLowerCase() === 'n' && create()) {
        event.preventDefault();
      }
    }
    window.addEventListener('keydown', listen);
    return () => {
      window.removeEventListener('keydown', listen);
    };
  }, []);
}
