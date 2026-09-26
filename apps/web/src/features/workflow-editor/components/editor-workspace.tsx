import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import type {
  NodeTestHandle,
  WorkflowIssuesView,
  WorkflowValidationTarget,
} from '@/features/workflow-publish/public';
import type { ApiClient } from '@/lib/api/client';
import {
  useEditorStore,
  useEditorStoreApi,
} from '../model/editor-store-context';
import type { useCanvasEffects } from '../use-canvas-effects';
import type { useEditorActions } from '../use-editor-actions';
import { useEditorShortcuts } from '../use-editor-shortcuts';
import {
  useInspectorNavigation,
  type MobilePanel,
} from '../use-inspector-navigation';
import { useLastTest } from '../use-last-test';
import { useQuickAdd } from '../use-quick-add';
import { useStepPlacement } from '../use-step-placement';
import { AddStepLens } from './add-step/add-step-lens';
import { QuickAddLens } from './add-step/quick-add-lens';
import { SelectionToolbar } from './canvas/selection-toolbar';
import { StartPicker } from './canvas/start-picker';
import { TestResultBar } from './chrome/test-result-bar';
import { ValidationSweep } from './canvas/validation-sweep';
import { WorkflowCanvas } from './canvas/workflow-canvas';
import { EditorLayout } from './editor-layout';
import { EditorInspector } from './inspector/editor-inspector';

export type EditorChrome = Readonly<{
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
  connections,
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
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
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
  const inConflict = useEditorStore((state) => state.saveStatus === 'conflict');
  const inspectorOpen = useEditorStore(
    (state) => state.selectedNodeIds.length > 0,
  );
  const editable = canUpdate && !inConflict;
  const canvasRef = useRef<HTMLDivElement>(null);
  const testRef = useRef<NodeTestHandle>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const { request } = actions;
  const navigation = useInspectorNavigation(request);
  const lastTest = useLastTest();
  const { setMobilePanel } = navigation;
  const addStep = useAddStepFold(editable, setMobilePanel);
  const { placement, quickAdd, addAfter, addToBody } = useStepAdding({
    store,
    definitions,
    canvasRef,
    editable,
  });

  const { selectNodes, removeEdge, deleteSelection, duplicateSelection } =
    useSelectionCommands(store, request, editable);
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

  const overlays = useCanvasOverlays(issues, effects);
  const chrome: EditorChrome = {
    shortcutsOpen,
    onShortcutsOpenChange: setShortcutsOpen,
    issuesOpen,
    onIssuesOpenChange: setIssuesOpen,
    onFix: navigation.fix,
  };
  return (
    <EditorLayout
      bar={bar(chrome)}
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
      banner={banner}
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
          containerRef={canvasRef}
          onSelectNodes={selectNodes}
          onRemoveEdge={removeEdge}
          onDropStep={placement.addAt}
          onPortDrop={quickAdd.openAtDrop}
          onAddToBody={addToBody}
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
          definitions={definitions}
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
          connections={connections}
          userId={userId}
          lookUpChannels={workspace.capabilities.includes('connection:use')}
          addConnections={workspace.capabilities.includes('connection:manage')}
          editable={editable}
          tab={navigation.tab}
          onTabChange={navigation.setTab}
          actions={actions}
          ensureSaved={ensureSaved}
          testRef={testRef}
          rememberedTest={lastTest.last}
          onTestFinished={lastTest.record}
          onTestPassed={effects.showTestPath}
          onClose={() => {
            setMobilePanel('none');
            request({ kind: 'select', nodeIds: [] });
          }}
          onAddStepAfter={addAfter}
          onAddToBody={addToBody}
          onDuplicateSelection={duplicateSelection}
          onRemoveEdge={removeEdge}
        />
      }
      overlay={
        <>
          <SelectionToolbar
            editable={editable}
            onDuplicate={duplicateSelection}
            onDelete={deleteSelection}
          />
          <QuickAddLens
            // It renders in a portal, outside the workspace a pause makes inert.
            request={editable && !paused ? quickAdd.request : undefined}
            definitions={definitions}
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
function useAddStepFold(
  editable: boolean,
  setMobilePanel: (panel: MobilePanel) => void,
) {
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
) {
  return useMemo(
    () => ({
      issuesByNode: issues.countsByNode,
      flowingEdgeIds: effects.flowingEdgeIds,
      weaveOrder: effects.weaveOrder,
      testOutputBytes: effects.testOutputBytes,
    }),
    [
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
function useSelectionCommands(
  store: ReturnType<typeof useEditorStoreApi>,
  request: ReturnType<typeof useEditorActions>['request'],
  editable: boolean,
) {
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
