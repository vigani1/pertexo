import { useState } from 'react';
import type { EditorAction, EditorFocusTarget } from './use-editor-actions';

export type InspectorTab = 'setup' | 'inputs' | 'test' | 'about';
export type MobilePanel = 'none' | 'add' | 'inspector';

/**
 * Where the inspector is and how commands jump into it: the open tab, the
 * small-screen panel, "Fix", which selects the step, opens the tab that
 * owns the field and focuses it, and "View output" for a step's last test.
 */
export function useInspectorNavigation(
  request: (action: EditorAction) => void,
) {
  const [tab, setTab] = useState<InspectorTab>('setup');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');

  /**
   * Shows a tab. Every tab stays mounted, and a command's focus lands in an
   * effect after this render, once the tab is on screen.
   */
  function openTab(next: InspectorTab) {
    setTab(next);
    setMobilePanel('inspector');
  }

  function fix(target: EditorFocusTarget) {
    openTab(target.mappingKey === undefined ? 'setup' : 'inputs');
    request({ kind: 'select', nodeIds: [target.nodeId], focusTarget: target });
  }

  /** "View output": the step's Test tab, at its last test's result. */
  function showTestOutput(nodeId: string) {
    openTab('test');
    request({
      kind: 'select',
      nodeIds: [nodeId],
      focusTarget: { nodeId, testOutput: true },
    });
  }

  return {
    tab,
    setTab,
    mobilePanel,
    setMobilePanel,
    openTab,
    fix,
    showTestOutput,
  } as const;
}
