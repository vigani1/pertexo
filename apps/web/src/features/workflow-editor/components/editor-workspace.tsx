import type { CodeSettings } from '@pertexo/node-sdk';
import type {
  NodeDefinitionCatalogItem,
  WorkflowSummary,
  ConnectionResponse,
  AccessibleWorkspace,
} from '@pertexo/contracts';
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  NodeTestHandle,
  WorkflowIssuesView,
  WorkflowValidationTarget,
} from '@/features/workflow-publish/public';
import { useQuery } from '@tanstack/react-query';
import { stepSamplesQueryOptions } from '@/features/workflow-publish/step-samples.public';
import type { ApiClient } from '@/lib/api/client';
import { useEditorStore, useEditorStoreApi } from '../model/state/context';
import type { useCanvasEffects } from '../hooks/use-canvas-effects';
import type { useEditorActions } from '../hooks/use-editor-actions';
import { useEditorShortcuts } from '../hooks/use-editor-shortcuts';
import { useLastTest } from '../hooks/use-last-test';
import { AddStepLens } from './add-step/lens';
import { QuickAddLens } from './add-step/quick-add-lens';
import { NoteTools } from './canvas/notes/tools';
import { SelectionToolbar } from './canvas/selection-toolbar';
import { StartPicker } from './canvas/start-picker';
import { TestResultBar } from './chrome/test-result-bar';
import { ValidationSweep } from './canvas/validation-sweep';
import { WorkflowCanvas } from './canvas/index';
import { EditorLayout } from './editor-layout';
import { WorkspaceInspector } from './workspace-inspector';
import { useEditorWorkflowTests } from '../hooks/use-editor-workflow-tests';
import {
  WorkflowTestButton,
  WorkflowTestHistory,
  WorkflowTestDialog,
  WorkflowTestMenuItems,
} from '@/features/workflow-publish/workflow-tests.public';
import { useAddStepFold } from './workspace-canvas';
import { useCanvasOverlays } from './workspace-canvas';
import { useStepAdding } from './workspace-canvas';
import { useSelectionCommands } from './workspace-canvas';

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
}: Readonly<{
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
}>) {
  const store = useEditorStoreApi();
  const { tests, testStatuses, revision, graph } = useEditorWorkflowTests({
    apiClient,
    userId,
    workspace,
    workflowId,
    paused,
    ensureSaved,
    verifyIdentity,
  });
  const inConflict = useEditorStore((state) => state.saveStatus === 'conflict');
  const inspectorOpen = useEditorStore(
    (state) => state.selectedNodeIds.length > 0,
  );
  const editable = canUpdate && !inConflict;
  const canvasRef = useRef<HTMLDivElement>(null);
  const testRef = useRef<NodeTestHandle>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const { request, navigation } = actions;
  const lastTest = useLastTest();
  const { setMobilePanel } = navigation;
  const addStep = useAddStepFold({ editable, setMobilePanel });
  // An instance with Code steps off doesn't offer them; existing ones explain.
  const placeable =
    codeSettings?.enabled === false
      ? definitions.filter(({ definition }) => definition.key !== 'core.code')
      : definitions;
  const adding = useStepAdding({
    store,
    definitions,
    canvasRef,
    editable,
  });

  const { placement, quickAdd, addToBody } = adding;

  const selection = useSelectionCommands({ store, request, editable });
  const { selectNodes, removeEdge, deleteSelection, duplicateSelection } =
    selection;
  useEditorShortcuts(
    {
      undo: () => {
        request({ kind: 'undo' });
      },
      redo: () => {
        request({ kind: 'redo' });
      },
      deleteSelection,
      duplicateSelection,
      focusAddStep: addStep.focus,
      toggleAddStep: addStep.toggle,
      testSelectedStep: () => {
        if (store.getState().selectedNodeId === null) return;
        navigation.openTab('test');
        testRef.current?.runTest();
      },
      save: () => void flushSave(),
      showShortcuts: () => {
        setShortcutsOpen(true);
      },
    },
    () => paused,
  );

  const sampleScope = {
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  };
  const samples = useQuery({
    ...stepSamplesQueryOptions(sampleScope),
    enabled: !paused && workspace.capabilities.includes('run:read'),
  });
  const overlays = useCanvasOverlays(issues, effects, testStatuses);
  const [feedbackTarget, setFeedbackTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const chrome: EditorChrome = {
    renderFeedback: (feedback) =>
      feedbackTarget === null ? null : createPortal(feedback, feedbackTarget),
    workflowTestAction: (
      <WorkflowTestButton tests={tests} className="hidden sm:inline-flex" />
    ),
    workflowTestMenuItems: <WorkflowTestMenuItems tests={tests} />,
    shortcutsOpen,
    onShortcutsOpenChange: setShortcutsOpen,
    issuesOpen,
    onIssuesOpenChange: setIssuesOpen,
    onFix: navigation.fix,
  };
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
      onMobilePanelChange={setMobilePanel}
      inspectorOpen={inspectorOpen}
      canvas={
        <WorkflowCanvas
          definitions={definitions}
          editable={editable}
          overlays={overlays}
          samples={samples.isError ? undefined : samples.data?.items}
          containerRef={canvasRef}
          onSelectNodes={selectNodes}
          onRemoveEdge={removeEdge}
          onDropStep={placement.addAt}
          onPortDrop={quickAdd.openAtDrop}
          onAddToBody={addToBody}
          onOpenStep={() => {
            // The first tap already selected it; this only brings its panel
            // up where panels fold away, and leaves the tab as it was.
            setMobilePanel('inspector');
          }}
        >
          <StartPicker
            definitions={definitions}
            editable={editable}
            onPick={placement.addAtCentre}
          />
          <ValidationSweep active={checking} />
        </WorkflowCanvas>
      }
      addStep={
        <AddStepLens
          definitions={placeable}
          collapsed={addStep.collapsed}
          searchRef={addStep.searchRef}
          onToggleCollapsed={addStep.toggle}
          onAdd={(choice) => {
            placement.addAtCentre(choice.definition);
            setMobilePanel('none');
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
        <>
          <div
            ref={setFeedbackTarget}
            className="pointer-events-none absolute inset-0 z-40"
          />
          {paused || !tests.open ? null : (
            <WorkflowTestDialog
              tests={tests}
              workspace={workspace}
              workflow={workflow}
              graph={graph}
            />
          )}
          <SelectionToolbar
            editable={editable}
            onDuplicate={duplicateSelection}
            onDelete={deleteSelection}
          />
          <QuickAddLens
            // It renders in a portal, outside the workspace a pause makes inert.
            request={editable && !paused ? quickAdd.request : undefined}
            definitions={placeable}
            fallbackFocus={canvasRef}
            onPortChange={quickAdd.choosePort}
            onChoose={quickAdd.choose}
            onClose={quickAdd.close}
          />
        </>
      }
    />
  );
}
