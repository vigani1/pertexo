import {
  WorkflowTestHistory,
  type NodeTestHandle,
} from '@/features/workflow-testing/workflow-testing-views.public';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { useState, useRef, type ReactNode, type RefObject } from 'react';
import { DraftProposal } from './draft-proposal';
import type { WorkflowValidationTarget } from '@/features/workflow-publish/public';
import { useEditorStore, useEditorSession } from '../model/state/context';
import { useLastTest } from '../hooks/use-last-test';
import { LastRunContext } from '../model/canvas/last-run-context';
import { useLastRun } from '../hooks/use-last-run';
import { LastRunLine } from './canvas/last-run-line';
import { useAssistantOpening } from '../hooks/use-assistant-opening';
import { AddStepLens } from './add-step/lens';
import { TestResultBar } from './chrome/test-result-bar';
import { EditorLayout } from './editor-layout';
import { WorkspaceSurface, WorkspaceOverlay } from './workspace-surfaces';
import { WorkspaceInspector } from './workspace-inspector';
import { useEditorWorkflowTests } from '../hooks/publication/use-editor-workflow-tests';

import { useCanvasOverlays, useCanvasEditing } from './workspace-canvas';
import { useWorkspaceChrome } from '../hooks/use-workspace-chrome';

export type EditorChrome = Readonly<{
  overflowRef: RefObject<HTMLButtonElement | null>;
  renderTestAction: (runItems: ReactNode, runPending: boolean) => ReactNode;
  renderFeedback: (feedback: ReactNode) => ReactNode;
  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;
  /** The bottom issues lens, opened from the command bar's chip. */
  issuesOpen: boolean;
  onIssuesOpenChange: (open: boolean) => void;
  onFix: (target: WorkflowValidationTarget) => void;
  openProposal: () => void;
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
  const { canUpdate, paused, actions, ensureSaved, effects } = editing;
  const { tests, testStatuses, revision, graph } = useEditorWorkflowTests({
    ...scope,
    paused,
    ensureSaved,
    verifyIdentity: editing.verifyIdentity,
  });
  const inspectorOpen = useEditorStore(
    (state) => state.selectedNodeIds.length > 0,
  );
  const testRef = useRef<NodeTestHandle>(null);
  const { navigation } = actions;
  const lastTest = useLastTest();
  const lastRun = useLastRun({ apiClient, userId, workspace, workflowId });
  const { chrome: workspaceChrome, setFeedbackTarget } = useWorkspaceChrome({
    tests,
    onFix: navigation.fix,
  });
  const { issuesOpen, onShortcutsOpenChange: setShortcutsOpen } =
    workspaceChrome;
  const { editable, canvasRef, addStep, adding, selection, placeable } =
    useCanvasEditing({
      definitions,
      codeSettings,
      canUpdate,
      paused,
      actions,
      testRef,
      flushSave: editing.flushSave,
      onShortcuts: () => {
        setShortcutsOpen(true);
      },
    });
  const assistant = useAssistantOpening({
    onOpen: adding.quickAdd.close,
    canvasRef,
  });
  const [proposal, setProposal] = useState<WorkflowGraphContract>();
  const chrome: EditorChrome = { ...workspaceChrome, ...assistant.chrome };
  const overlays = useCanvasOverlays(editing.issues, effects, testStatuses, {
    lastRun,
    proposal: assistant.open ? proposal : undefined,
  });
  return (
    <EditorLayout
      addStep={
        <AddStepLens
          definitions={placeable}
          fold={addStep}
          onAdd={(choice) => {
            adding.placement.addAtCentre(choice.definition);
            navigation.setMobilePanel('none');
          }}
        />
      }
      inspector={
        <LastRunContext value={lastRun.overlay}>
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
        </LastRunContext>
      }
      assistant={
        <DraftProposal
          open={assistant.open}
          onClose={assistant.close}
          onPreview={setProposal}
        />
      }
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
          placeable={placeable}
          editable={editable && proposal === undefined}
          overlays={overlays}
          canvas={{ canvasRef, adding, selection }}
          checking={editing.checking}
          showStartPicker={!assistant.open}
          onOpenInspector={() => {
            navigation.setMobilePanel('inspector');
          }}
          onAddStep={addStep.focus}
        />
      }
      overlay={
        <WorkspaceOverlay
          feedbackTarget={setFeedbackTarget}
          editable={editable}
          paused={paused}
          testing={{ tests, workspace, workflow: editing.workflow, graph }}
          selection={selection}
          adding={adding}
          definitions={placeable}
          canvasRef={canvasRef}
        />
      }
      panels={{
        editable: canUpdate,
        addStepCollapsed: addStep.collapsed,
        onOpenAddStep: addStep.focus,
        mobilePanel: navigation.mobilePanel,
        onMobilePanelChange: navigation.setMobilePanel,
        inspectorOpen: inspectorOpen && !assistant.open,
        assistantOpen: assistant.open,
      }}
      header={{
        bar: bar(chrome),
        canvasTools: <LastRunLine lastRun={lastRun} />,
        banner: <>{banner}</>,
      }}
    />
  );
}
