import { useCallback, useState } from 'react';
import type { EditorFocusTarget } from './use-editor-actions';

export type InspectorTab = 'setup' | 'inputs' | 'test' | 'runs' | 'about';
export type MobilePanel = 'none' | 'add' | 'inspector';

/**
 * Where the inspector is and how commands jump into it: the open tab, the
 * small-screen panel, "Fix", which selects the step, opens the tab that
 * owns the field and focuses it, and "View output" for a step's last test.
 */
export function useInspectorNavigation() {
  const [tab, setTab] = useState<InspectorTab>('setup');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');

  /**
   * Shows a tab. Every tab stays mounted, and a command's focus lands in an
   * effect after this render, once the tab is on screen.
   */
  const openTab = useCallback((next: InspectorTab) => {
    setTab(next);
    setMobilePanel('inspector');
  }, []);

  /** Called only when the editor's guarded selection has been accepted. */
  const focusStep = useCallback(
    (target: EditorFocusTarget) => {
      openTab(
        target.testOutput === true
          ? 'test'
          : target.mappingKey === undefined
            ? 'setup'
            : 'inputs',
      );
    },
    [openTab],
  );

  return {
    tab,
    setTab,
    mobilePanel,
    setMobilePanel,
    openTab,
    focusStep,
  } as const;
}
