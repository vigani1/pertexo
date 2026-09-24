import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
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
import type { useCanvasEffects } from '../model/use-canvas-effects';
import type { useEditorActions } from '../model/use-editor-actions';
import { useEditorShortcuts } from '../model/use-editor-shortcuts';
import { useInspectorNavigation } from '../model/use-inspector-navigation';
import { useStepPlacement } from '../model/use-step-placement';
import { AddStepLens } from './add-step/add-step-lens';
import { SelectionToolbar } from './canvas/selection-toolbar';
import { StartPicker } from './canvas/start-picker';
import { ValidationSweep } from './canvas/validation-sweep';
import { WorkflowCanvas } from './canvas/workflow-canvas';
import { EditorLayout } from './editor-layout';
import { EditorInspector } from './inspector/editor-inspector';

export type EditorChrome = Readonly<{
  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;
  onFix: (target: WorkflowValidationTarget) => void;
}>;

/**
 * The editing surfaces and their interaction state: canvas, add-step lens,
 * inspector, keyboard shortcuts and small-screen panels. Every change goes
 * through the editor store or the session's guarded actions.
 */
export function EditorWorkspace({
  apiClient,
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
}: Readonly<{
  apiClient: ApiClient;
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
}>) {
  const store = useEditorStoreApi();
  const inConflict = useEditorStore((state) => state.saveStatus === 'conflict');
  const inspectorOpen = useEditorStore(
    (state) => state.selectedNodeIds.length > 0,
  );
  const editable = canUpdate && !inConflict;
  const canvasRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const testRef = useRef<NodeTestHandle>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { request } = actions;
  const navigation = useInspectorNavigation(request);
  const { setMobilePanel } = navigation;
  const placement = useStepPlacement({
    store,
    definitions,
    canvasRef,
    onPlaced: (nodeId) => {
      if (!store.getState().inspectorScratch)
        store.getState().selectNode(nodeId);
    },
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
      focusAddStep: () => {
        if (!editable) return;
        flushSync(() => {
          setCollapsed(false);
          setMobilePanel('add');
        });
        searchRef.current?.focus();
      },
      toggleAddStep: () => {
        setCollapsed((current) => !current);
      },
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

  const overlays = useMemo(
    () => ({
      issuesByNode: issues.countsByNode,
      flowingEdgeIds: effects.flowingEdgeIds,
      weaveOrder: effects.weaveOrder,
    }),
    [effects.flowingEdgeIds, effects.weaveOrder, issues.countsByNode],
  );
  return (
    <EditorLayout
      bar={bar({
        shortcutsOpen,
        onShortcutsOpenChange: setShortcutsOpen,
        onFix: navigation.fix,
      })}
      banner={banner}
      editable={canUpdate}
      addStepCollapsed={collapsed}
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
          collapsed={collapsed}
          searchRef={searchRef}
          onToggleCollapsed={() => {
            setCollapsed((current) => !current);
          }}
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
          workflowId={workflowId}
          definitions={definitions}
          connections={connections}
          editable={editable}
          tab={navigation.tab}
          onTabChange={navigation.setTab}
          actions={actions}
          ensureSaved={ensureSaved}
          testRef={testRef}
          onTestPassed={effects.showTestPath}
          onClose={() => {
            setMobilePanel('none');
            request({ kind: 'select', nodeIds: [] });
          }}
          onDuplicateSelection={duplicateSelection}
          onDeleteSelection={deleteSelection}
          onRemoveEdge={removeEdge}
        />
      }
      overlay={
        <SelectionToolbar
          editable={editable}
          onDuplicate={duplicateSelection}
          onDelete={deleteSelection}
        />
      }
    />
  );
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
