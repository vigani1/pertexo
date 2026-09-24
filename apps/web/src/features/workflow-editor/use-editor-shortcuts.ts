import { useEffect, useEffectEvent } from 'react';

export type EditorShortcutHandlers = Readonly<{
  undo: () => void;
  redo: () => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  focusAddStep: () => void;
  toggleAddStep: () => void;
  testSelectedStep: () => void;
  save: () => void;
  showShortcuts: () => void;
}>;

/**
 * One window listener for the editor's keyboard shortcuts. Text inputs keep
 * their own keys (typing "/", ⌫ and native ⌘Z), so only ⌘S and ⌘↵, which
 * never edit text, reach the editor from inside a field. Deletion is scoped
 * to the canvas so a stray ⌫ elsewhere never removes a step.
 */
export function useEditorShortcuts(
  handlers: EditorShortcutHandlers,
  isPaused: () => boolean,
) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (isPaused() || event.defaultPrevented) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === 's') {
      event.preventDefault();
      handlers.save();
      return;
    }
    if (command && event.key === 'Enter') {
      event.preventDefault();
      handlers.testSelectedStep();
      return;
    }
    if (isEditableTarget(event.target) || isInsideDialog(event.target)) return;
    const action = commandFor(event, command, key);
    if (action === undefined) return;
    event.preventDefault();
    handlers[action]();
  });
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      onKeyDown(event);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
}

function commandFor(
  event: KeyboardEvent,
  command: boolean,
  key: string,
): keyof EditorShortcutHandlers | undefined {
  if (command && key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (command && key === 'y') return 'redo';
  if (command && key === 'd') return 'duplicateSelection';
  if (command && key === 'b') return 'toggleAddStep';
  if (command || event.altKey) return undefined;
  if (event.key === '/') return 'focusAddStep';
  if (event.key === '?') return 'showShortcuts';
  if (
    (event.key === 'Delete' || event.key === 'Backspace') &&
    document.activeElement?.closest('[data-workflow-canvas]') !== null
  )
    return 'deleteSelection';
  return undefined;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
  );
}

function isInsideDialog(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('[role="dialog"],[role="alertdialog"],[role="menu"]') !==
      null
  );
}
