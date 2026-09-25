import { useState } from 'react';
import { flushSync } from 'react-dom';
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
