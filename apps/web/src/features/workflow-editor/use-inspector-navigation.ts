import { useState } from 'react';
import { flushSync } from 'react-dom';
import type { EditorAction, EditorFocusTarget } from './use-editor-actions';

export type InspectorTab = 'setup' | 'inputs' | 'test' | 'about';
export type MobilePanel = 'none' | 'add' | 'inspector';

/**
 * Where the inspector is and how commands jump into it: the open tab, the
 * small-screen panel, and "Fix", which selects the step, opens the tab that
 * owns the field and focuses it.
 */
export function useInspectorNavigation(
  request: (action: EditorAction) => void,
) {
  const [tab, setTab] = useState<InspectorTab>('setup');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');

  /** Shows a tab now, so a command can focus what's inside it. */
  function openTab(next: InspectorTab) {
    flushSync(() => {
      setTab(next);
      setMobilePanel('inspector');
    });
  }

  function fix(target: EditorFocusTarget) {
    openTab(target.mappingKey === undefined ? 'setup' : 'inputs');
    request({ kind: 'select', nodeIds: [target.nodeId], focusTarget: target });
  }

  return {
    tab,
    setTab,
    mobilePanel,
    setMobilePanel,
    openTab,
    fix,
  } as const;
}
