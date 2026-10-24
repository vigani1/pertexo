import type { CodeSettings } from '@pertexo/node-sdk';
import type {
  NodeDefinitionCatalogItem,
  WorkflowNodeRunSummary,
  WorkflowSummary,
  ConnectionResponse,
  AccessibleWorkspace,
} from '@pertexo/contracts';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import type {
  NodeTestHandle,
  WorkflowIssuesView,
  WorkflowValidationTarget,
} from '@/features/workflow-publish/public';
import { useQuery } from '@tanstack/react-query';
import {
  PinRecordedOutputButton,
  stepSamplesQueryOptions,
} from '@/features/workflow-publish/step-samples.public';
import type { ApiClient } from '@/lib/api/client';
import { useEditorStore, useEditorStoreApi } from '../model/state/context';
import type { useCanvasEffects } from '../hooks/use-canvas-effects';
import type { useEditorActions } from '../hooks/use-editor-actions';
import { useEditorShortcuts } from '../hooks/use-editor-shortcuts';
import type { MobilePanel } from '../hooks/use-inspector-navigation';
import { useLastTest } from '../hooks/use-last-test';
import { useQuickAdd } from './add-step/use-quick-add';
import { useStepPlacement } from './add-step/use-step-placement';
import { AddStepLens } from './add-step/lens';
import { QuickAddLens } from './add-step/quick-add-lens';
import { NoteTools } from './canvas/notes/tools';
import { SelectionToolbar } from './canvas/selection-toolbar';
import { StartPicker } from './canvas/start-picker';
import { TestResultBar } from './chrome/test-result-bar';
import { ValidationSweep } from './canvas/validation-sweep';
import { WorkflowCanvas } from './canvas/index';
import { EditorLayout } from './editor-layout';
import { EditorInspector } from './inspector/editor';
import { useEditorWorkflowTests } from '../hooks/use-editor-workflow-tests';
import {
  WorkflowTestButton,
  WorkflowTestHistory,
  WorkflowTestDialog,
  WorkflowTestMenuItems,
} from '@/features/workflow-publish/workflow-tests.public';
import { StepHistoryPanel } from '@/features/workflow-runs/step-history.public';

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
  const { placement, quickAdd, addAfter, addToBody } = useStepAdding({
    store,
    definitions,
    canvasRef,
    editable,
  });

  const { selectNodes, removeEdge, deleteSelection, duplicateSelection } =
    useSelectionCommands({ store, request, editable });
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
        <EditorInspector
          apiClient={apiClient}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          workflowId={workflowId}
          definitions={definitions}
          codeSettings={codeSettings}
          connections={connections}
          userId={userId}
          lookUpChannels={
            connectionsAvailable &&
            workspace.capabilities.includes('connection:use')
          }
          addConnections={
            connectionsAvailable &&
            workspace.capabilities.includes('connection:manage')
          }
          editable={editable && !paused}
          tab={navigation.tab}
          onTabChange={navigation.setTab}
          actions={actions}
          ensureSaved={ensureSaved}
          testRef={testRef}
          rememberedTest={lastTest.last}
          onTestFinished={lastTest.record}
          onTestPassed={effects.showTestPath}
          renderStepRuns={(nodeId, stepLabel) => (
            <StepHistoryPanel
              apiClient={apiClient}
              userId={userId}
              workspace={workspace}
              workflowId={workflowId}
              nodeId={nodeId}
              stepLabel={stepLabel}
              renderActions={(run) =>
                editable && !paused && run.status === 'succeeded' ? (
                  <PinRecordedOutputButton
                    scope={sampleScope}
                    nodeId={nodeId}
                    runId={run.runId}
                    nodeRunId={run.nodeRunId}
                    ensureSaved={ensureSaved}
                  />
                ) : null
              }
            />
          )}
          onClose={() => {
            setMobilePanel('none');
            request({ kind: 'select', nodeIds: [] });
          }}
          onAddStepAfter={addAfter}
          onAddFailureHandler={quickAdd.openFailure}
          onAddToBody={addToBody}
          onDuplicateSelection={duplicateSelection}
          onRemoveEdge={removeEdge}
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

/** The add-step lens's fold and its search field, which "/" focuses. */
function useAddStepFold({
  editable,
  setMobilePanel,
}: Readonly<{
  editable: boolean;
  setMobilePanel: (panel: MobilePanel) => void;
}>) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  return {
    searchRef,
    collapsed,
    toggle: () => {
      setCollapsed((current) => !current);
    },
    focus: () => {
      if (!editable) return;
      flushSync(() => {
        setCollapsed(false);
        setMobilePanel('add');
      });
      searchRef.current?.focus();
    },
  } as const;
}

/**
 * What the canvas draws over the steps: issue counts, a passed test's path
 * and output size, and the publish weave. A valid step says nothing: a
 * mark that came and went with every check made each card grow and shrink.
 */
function useCanvasOverlays(
  issues: WorkflowIssuesView,
  effects: ReturnType<typeof useCanvasEffects>,
  testStatuses:
    ReadonlyMap<string, WorkflowNodeRunSummary['status']> | undefined,
) {
  return useMemo(
    () => ({
      issuesByNode: issues.countsByNode,
      flowingEdgeIds: effects.flowingEdgeIds,
      weaveOrder: effects.weaveOrder,
      testOutputBytes: effects.testOutputBytes,
      testStatuses,
    }),
    [
      testStatuses,
      effects.flowingEdgeIds,
      effects.testOutputBytes,
      effects.weaveOrder,
      issues.countsByNode,
    ],
  );
}

/**
 * How new steps are added: placed from the add-step lens or a drag, or
 * quick-added after a step or into a For each body. A new step is selected
 * unless the inspector holds an unfinished edit.
 */
function useStepAdding({
  store,
  definitions,
  canvasRef,
  editable,
}: Readonly<{
  store: ReturnType<typeof useEditorStoreApi>;
  definitions: readonly NodeDefinitionCatalogItem[];
  canvasRef: RefObject<HTMLDivElement | null>;
  editable: boolean;
}>) {
  const placement = useStepPlacement({
    store,
    definitions,
    canvasRef,
    onPlaced: (nodeId) => {
      if (!store.getState().inspectorScratch)
        store.getState().selectNode(nodeId);
    },
  });
  const quickAdd = useQuickAdd({
    store,
    definitions,
    onAdd: placement.addFromQuickAdd,
  });
  return {
    placement,
    quickAdd,
    addAfter: (nodeId: string, returnFocus: HTMLElement | null) => {
      if (editable) quickAdd.openAfter(nodeId, returnFocus);
    },
    addToBody: (loopId: string, opener: HTMLElement) => {
      if (editable) quickAdd.openInBody(loopId, opener);
    },
  } as const;
}

/** Canvas selection commands, all routed through the guarded request. */
function useSelectionCommands({
  store,
  request,
  editable,
}: Readonly<{
  store: ReturnType<typeof useEditorStoreApi>;
  request: ReturnType<typeof useEditorActions>['request'];
  editable: boolean;
}>) {
  const selectNodes = useCallback(
    (nodeIds: readonly string[]) => {
      request({ kind: 'select', nodeIds });
    },
    [request],
  );
  const removeEdge = useCallback(
    (edgeId: string) => {
      request({ kind: 'delete', nodeIds: [], edgeIds: [edgeId] });
    },
    [request],
  );
  function deleteSelection() {
    const state = store.getState();
    if (editable)
      request({
        kind: 'delete',
        nodeIds: state.selectedNodeIds,
        edgeIds: state.selectedEdgeIds,
      });
  }
  function duplicateSelection() {
    if (editable)
      request({ kind: 'duplicate', nodeIds: store.getState().selectedNodeIds });
  }
  return { selectNodes, removeEdge, deleteSelection, duplicateSelection };
}
