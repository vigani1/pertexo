import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { Connection } from '@xyflow/react';
import { useState, type Ref } from 'react';
import { useCopyToClipboard } from '@/components/ui/use-copy-to-clipboard';
import {
  NodeTestPanel,
  type NodeTestHandle,
} from '@/features/workflow-publish/public';
import type { ApiClient } from '@/lib/api/client';
import {
  useEditorStore,
  useEditorStoreApi,
} from '../../model/editor-store-context';
import { stepTitle } from '../../model/graph-adapter';
import { connectWorkflowNodes } from '../../model/graph-commands';
import type { useEditorActions } from '../../use-editor-actions';
import { InspectorPanel } from './inspector-panel';
import type { InspectorTab } from '../../use-inspector-navigation';

type PassedTest = Readonly<{ previewId: string; nodeId: string }>;

/**
 * The inspector lens wired to the editor: step commands go through the
 * guarded actions, and the Test tab remembers the last passed test so the
 * next step can reuse its output.
 */
export function EditorInspector({
  apiClient,
  workspaceId,
  workflowId,
  definitions,
  connections,
  editable,
  tab,
  onTabChange,
  actions,
  ensureSaved,
  testRef,
  onTestPassed,
  onClose,
  onDuplicateSelection,
  onDeleteSelection,
  onRemoveEdge,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  editable: boolean;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  actions: ReturnType<typeof useEditorActions>;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  testRef: Ref<NodeTestHandle>;
  onTestPassed: (nodeId: string) => void;
  onClose: () => void;
  onDuplicateSelection: () => void;
  onDeleteSelection: () => void;
  onRemoveEdge: (edgeId: string) => void;
}>) {
  const store = useEditorStoreApi();
  const copy = useCopyToClipboard();
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const [passedTest, setPassedTest] = useState<PassedTest>();

  function copyStepId() {
    if (selectedNodeId === null) return;
    void copy(selectedNodeId, 'step ID', {
      elsewhere: 'Copy it from About.',
    });
  }

  return (
    <InspectorPanel
      definitions={definitions}
      connections={connections}
      workspaceId={workspaceId}
      editable={editable}
      scratchVersion={actions.scratchVersion}
      tab={tab}
      onTabChange={onTabChange}
      focusTarget={actions.focusTarget}
      onDuplicateSelection={onDuplicateSelection}
      onDeleteSelection={onDeleteSelection}
      actions={{
        onDuplicate: onDuplicateSelection,
        onCopyId: copyStepId,
        onDelete: () => {
          if (selectedNodeId !== null)
            actions.request({
              kind: 'delete',
              nodeIds: [selectedNodeId],
              edgeIds: [],
            });
        },
        onClose,
        onConnect: (connection: Connection) => {
          const state = store.getState();
          const next = connectWorkflowNodes(state.graph, connection);
          if (next !== null) state.transact(next);
        },
        onRemoveEdge,
        onDiscardScratch: actions.discardScratch,
      }}
      renderTest={(nodeId, stepSideEffect) => (
        <NodeTestPanel
          apiClient={apiClient}
          workspaceId={workspaceId}
          workflowId={workflowId}
          nodeId={nodeId}
          stepSideEffect={stepSideEffect}
          priorPreview={priorTestFor(graph, passedTest, nodeId)}
          ensureSaved={ensureSaved}
          actionRef={testRef}
          onSucceeded={(preview) => {
            setPassedTest({ previewId: preview.id, nodeId });
            onTestPassed(nodeId);
          }}
        />
      )}
    />
  );
}

/** A passed test of a step wired straight into this one can feed its test. */
function priorTestFor(
  graph: WorkflowGraphContract,
  passed: PassedTest | undefined,
  nodeId: string,
): Readonly<{ id: string; stepName: string }> | undefined {
  if (passed === undefined) return undefined;
  const wired = graph.edges.some(
    (edge) =>
      edge.source.nodeId === passed.nodeId && edge.target.nodeId === nodeId,
  );
  const source = graph.nodes.find((node) => node.id === passed.nodeId);
  return wired && source !== undefined
    ? { id: passed.previewId, stepName: stepTitle(source) }
    : undefined;
}
