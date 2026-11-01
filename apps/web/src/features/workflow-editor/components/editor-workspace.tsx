import { WorkflowTestHistory } from '@/features/workflow-publish/tests.public';
import { useRef, type ReactNode } from 'react';
import type {
  NodeTestHandle,
  WorkflowValidationTarget,
} from '@/features/workflow-publish/public';
import { useEditorStore, useEditorSession } from '../model/state/context';
import { useLastTest } from '../hooks/use-last-test';
import { AddStepLens } from './add-step/lens';
import { NoteTools } from './canvas/notes/tools';
import { TestResultBar } from './chrome/test-result-bar';
import { EditorLayout } from './editor-layout';
import { WorkspaceSurface, WorkspaceOverlay } from './workspace-surfaces';
import { WorkspaceInspector } from './workspace-inspector';
import { useEditorWorkflowTests } from '../hooks/use-editor-workflow-tests';

import { useCanvasOverlays } from './workspace-canvas';
import { useWorkspaceChrome } from '../hooks/use-workspace-chrome';
import { useCanvasEditing } from './workspace-canvas';

export type EditorChrome = Readonly<{
  workflowTestAction: ReactNode;
  /** The same test actions as items for the phone's ⋯ menu. */
  workflowTestMenuItems: ReactNode;
  renderFeedback: (feedback: ReactNode) => ReactNode;
  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;
  /** The bottom issues lens, opened from the command bar's chip. */
  issuesOpen: boolean;
  onIssuesOpenChange: (open: boolean) => void;
  onFix: (target: WorkflowValidationTarget) => void;
}>;

/**
 * The editing surfaces and their interaction state: canvas, add-step lens,
 * inspector, keyboard shortcuts and small-screen panels. Every change goes
 * through the editor store or the session's guarded actions.
 */
type EditorWorkspaceProps = Readonly<{
  bar: (chrome: EditorChrome) => ReactNode;
  banner: ReactNode;
  bottomLens: (chrome: EditorChrome) => ReactNode;
}>;

export function EditorWorkspace({
  bar,
  banner,
  bottomLens,
}: EditorWorkspaceProps) {
  const { scope, catalog, editing } = useEditorSession();
  const { apiClient, userId, workspace, workflowId } = scope;
  const { definitions, codeSettings } = catalog;
  const {
    workflow,
    verifyIdentity,
    canUpdate,
    paused,
    issues,
    checking,
    actions,
    ensureSaved,
    flushSave,
    effects,
  } = editing;
  const { tests, testStatuses, revision, graph } = useEditorWorkflowTests({
    apiClient,
    userId,
    workspace,
    workflowId,
    paused,
    ensureSaved,
    verifyIdentity,
  });
  const inspectorOpen = useEditorStore(
    (state) => state.selectedNodeIds.length > 0,
  );
  const testRef = useRef<NodeTestHandle>(null);
  const { navigation } = actions;
  const lastTest = useLastTest();
  const { chrome, setFeedbackTarget } = useWorkspaceChrome({
    tests,
    onFix: navigation.fix,
  });
  const { issuesOpen, onShortcutsOpenChange: setShortcutsOpen } = chrome;
  const { editable, canvasRef, addStep, adding, selection, placeable } =
    useCanvasEditing({
      definitions,
      codeSettings,
      canUpdate,
      paused,
      actions,
      testRef,
      flushSave,
      onShortcuts: () => {
        setShortcutsOpen(true);
      },
    });
  const overlays = useCanvasOverlays(issues, effects, testStatuses);
  return (
    <EditorLayout
      history={
        <WorkflowTestHistory
          tests={tests}
          ensureSaved={ensureSaved}
          currentRevision={revision}
          canCancelAny={workspace.capabilities.includes('run:cancel')}
        />
      }
      bottomLens={
        <>
          {bottomLens(chrome)}
          {issuesOpen ? null : (
            <TestResultBar
              test={lastTest.last}
              onViewOutput={navigation.showTestOutput}
            />
          )}
        </>
      }

      canvas={
        <WorkspaceSurface
          definitions={definitions}
          editable={editable}
          overlays={overlays}
          sampleScope={{
            apiClient,
            userId,
            workspaceId: workspace.id,
            workflowId,
          }}
          readSamples={!paused && workspace.capabilities.includes('run:read')}
          canvas={{ canvasRef, adding, selection }}
          checking={checking}
          onOpenInspector={() => {
            navigation.setMobilePanel('inspector');
          }}
        />
      }
      addStep={
        <AddStepLens
          definitions={placeable}
          collapsed={addStep.collapsed}
          searchRef={addStep.searchRef}
          onToggleCollapsed={addStep.toggle}
          onAdd={(choice) => {
            adding.placement.addAtCentre(choice.definition);
            navigation.setMobilePanel('none');
          }}
        />
      }
      inspector={
        <WorkspaceInspector
          editable={editable && !paused}

          testing={{
            tests,
            testRef,
            lastTest,
            onTestPassed: effects.showTestPath,
          }}
          canvas={{ adding, selection }}
        />
      }
      overlay={
        <WorkspaceOverlay
          feedbackTarget={setFeedbackTarget}
          editable={editable}
          paused={paused}
          testing={{ tests, workspace, workflow, graph }}
          selection={selection}
          adding={adding}
          definitions={placeable}
          canvasRef={canvasRef}
        />
      }
      panels={{
        editable: canUpdate,
        addStepCollapsed: addStep.collapsed,
        mobilePanel: navigation.mobilePanel,
        onMobilePanelChange: navigation.setMobilePanel,
        inspectorOpen: inspectorOpen,
      }}
      header={{
        bar: bar(chrome),
        canvasTools: <NoteTools editable={editable} containerRef={canvasRef} />,
        banner: <>{banner}</>,
      }}
    />
  );
}
