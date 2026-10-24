import { WorkflowTestHistory } from '@/features/workflow-publish/workflow-tests.public';
import type { CodeSettings } from '@pertexo/node-sdk';
import type {
  NodeDefinitionCatalogItem,
  WorkflowSummary,
  ConnectionResponse,
  AccessibleWorkspace,
} from '@pertexo/contracts';
import { useRef, type ReactNode } from 'react';
import type {
  NodeTestHandle,
  WorkflowIssuesView,
  WorkflowValidationTarget,
} from '@/features/workflow-publish/public';
import type { ApiClient } from '@/lib/api/client';
import { useEditorStore } from '../model/state/context';
import type { useCanvasEffects } from '../hooks/use-canvas-effects';
import type { useEditorActions } from '../hooks/use-editor-actions';
import { useLastTest } from '../hooks/use-last-test';
import { AddStepLens } from './add-step/lens';
import { NoteTools } from './canvas/notes/tools';
import { TestResultBar } from './chrome/test-result-bar';
import { EditorLayout } from './editor-layout';
import { WorkspaceSurface, WorkspaceOverlay } from './workspace-surfaces';
import { WorkspaceInspector } from './workspace-inspector';
import { useEditorWorkflowTests } from '../hooks/use-editor-workflow-tests';
import {} from '@/features/workflow-publish/workflow-tests.public';
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
  workflow: WorkflowSummary | undefined;
  verifyIdentity: () => Promise<void>;
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  codeSettings?: CodeSettings | undefined;
  connections: readonly ConnectionResponse[];
  /** False when the workspace's connections can't be read here at all. */
  connectionsAvailable: boolean;
  canUpdate: boolean;
  paused: boolean;
  issues: WorkflowIssuesView;
  checking: boolean;
  actions: ReturnType<typeof useEditorActions>;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  flushSave: () => Promise<void>;
  effects: ReturnType<typeof useCanvasEffects>;
  bar: (chrome: EditorChrome) => ReactNode;
  banner: ReactNode;
  /** The bottom lens: the issues the command bar's chip opens. */
  bottomLens: (chrome: EditorChrome) => ReactNode;
}>;

export function EditorWorkspace({
  apiClient,
  userId,
  workspace,
  workflowId,
  definitions,
  codeSettings,
  connections,
  connectionsAvailable,
  canUpdate,
  paused,
  issues,
  checking,
  actions,
  ensureSaved,
  flushSave,
  effects,
  bar,
  banner,
  bottomLens,
  workflow,
  verifyIdentity,
}: EditorWorkspaceProps) {
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
      bar={bar(chrome)}
      canvasTools={<NoteTools editable={editable} containerRef={canvasRef} />}
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
      banner={
        <>
          {banner}
          <WorkflowTestHistory
            tests={tests}
            ensureSaved={ensureSaved}
            currentRevision={revision}
            canCancel={workspace.capabilities.includes('run:cancel')}
          />
        </>
      }
      editable={canUpdate}
      addStepCollapsed={addStep.collapsed}
      mobilePanel={navigation.mobilePanel}
      onMobilePanelChange={navigation.setMobilePanel}
      inspectorOpen={inspectorOpen}
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
          scope={{ apiClient, userId, workspace, workflowId }}
          catalog={{
            definitions,
            codeSettings,
            connections,
            connectionsAvailable,
          }}
          actions={actions}
          editable={editable && !paused}
          ensureSaved={ensureSaved}
          testing={{ testRef, lastTest, onTestPassed: effects.showTestPath }}
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
    />
  );
}
