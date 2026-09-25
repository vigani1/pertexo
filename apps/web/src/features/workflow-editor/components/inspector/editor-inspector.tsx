import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { Connection } from '@xyflow/react';
import { useMemo, useState, type Ref } from 'react';
import { useCopyToClipboard } from '@/components/ui/use-copy-to-clipboard';
import {
  NodeTestPanel,
  type NodeTestHandle,
} from '@/features/workflow-publish/public';
import { SchedulePreviewScope } from '@/features/workflow-publish/schedule-preview.public';
import type { ApiClient } from '@/lib/api/client';
import {
  AddConnectionContext,
  type AddConnectionScope,
} from '../../model/add-connection-context';
import {
  useEditorStore,
  useEditorStoreApi,
} from '../../model/editor-store-context';
import { stepTitle } from '../../model/graph-adapter';
import { connectWorkflowNodes } from '../../model/graph-commands';
import { findStep, levelOf } from '../../model/graph-scopes';
import { inlineOutputBytes } from '../../model/step-card';
import type { useEditorActions } from '../../use-editor-actions';
import { InspectorPanel } from './inspector-panel';
import type { ChannelLookupScope } from './slack-channel-field';
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
  workspaceName,
  workflowId,
  definitions,
  connections,
  userId,
  lookUpChannels,
  addConnections,
  editable,
  tab,
  onTabChange,
  actions,
  ensureSaved,
  testRef,
  onTestPassed,
  onClose,
  onAddStepAfter,
  onAddToBody,
  onDuplicateSelection,
  onDeleteSelection,
  onRemoveEdge,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workspaceName: string;
  workflowId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  userId: string;
  /** Slack channel names are looked up for people who can use connections. */
  lookUpChannels: boolean;
  /** People who manage connections can add one from a step's slot. */
  addConnections: boolean;
  editable: boolean;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  actions: ReturnType<typeof useEditorActions>;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  testRef: Ref<NodeTestHandle>;
  onTestPassed: (nodeId: string, outputBytes: number | undefined) => void;
  onClose: () => void;
  onAddStepAfter: (nodeId: string, returnFocus: HTMLElement | null) => void;
  onAddToBody: (loopId: string, returnFocus: HTMLElement) => void;
  onDuplicateSelection: () => void;
  onDeleteSelection: () => void;
  onRemoveEdge: (edgeId: string) => void;
}>) {
  const store = useEditorStoreApi();
  const copy = useCopyToClipboard();
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const [passedTest, setPassedTest] = useState<PassedTest>();
  const channelLookup = useMemo<ChannelLookupScope>(
    () => ({ apiClient, userId, workspaceId, enabled: lookUpChannels }),
    [apiClient, lookUpChannels, userId, workspaceId],
  );
  const previewScope = useMemo(
    () => ({ apiClient, workspaceId, workflowId }),
    [apiClient, workspaceId, workflowId],
  );
  const connectionScope = useMemo<AddConnectionScope | null>(
    () =>
      addConnections
        ? { scope: { apiClient, userId, workspaceId }, workspaceName }
        : null,
    [addConnections, apiClient, userId, workspaceId, workspaceName],
  );

  function copyStepId() {
    if (selectedNodeId === null) return;
    void copy(selectedNodeId, 'step ID', {
      elsewhere: 'Copy it from About.',
    });
  }

  const panel = (
    <InspectorPanel
      definitions={definitions}
      connections={connections}
      channelLookup={channelLookup}
      editable={editable}
      scratchVersion={actions.scratchVersion}
      tab={tab}
      onTabChange={onTabChange}
      focusTarget={actions.focusTarget}
      onDuplicateSelection={onDuplicateSelection}
      onDeleteSelection={onDeleteSelection}
      actions={{
        onAddAfter: (returnFocus) => {
          if (selectedNodeId !== null)
            onAddStepAfter(selectedNodeId, returnFocus);
        },
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
        onSelectStep: (nodeId) => {
          actions.request({ kind: 'select', nodeIds: [nodeId] });
        },
        onAddToBody: (opener) => {
          if (selectedNodeId !== null) onAddToBody(selectedNodeId, opener);
        },
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
            onTestPassed(nodeId, inlineOutputBytes(preview.output));
          }}
        />
      )}
    />
  );
  // The Schedule step's builder previews its rule against this workflow, and
  // connection slots add connections to this workspace.
  return (
    <SchedulePreviewScope value={previewScope}>
      <AddConnectionContext value={connectionScope}>
        {panel}
      </AddConnectionContext>
    </SchedulePreviewScope>
  );
}

/** A passed test of a step wired straight into this one can feed its test. */
function priorTestFor(
  graph: WorkflowGraphContract,
  passed: PassedTest | undefined,
  nodeId: string,
): Readonly<{ id: string; stepName: string }> | undefined {
  if (passed === undefined) return undefined;
  const wired = levelOf(graph, nodeId)?.edges.some(
    (edge) =>
      edge.source.nodeId === passed.nodeId && edge.target.nodeId === nodeId,
  );
  const source = findStep(graph, passed.nodeId);
  return wired === true && source !== undefined
    ? { id: passed.previewId, stepName: stepTitle(source) }
    : undefined;
}
