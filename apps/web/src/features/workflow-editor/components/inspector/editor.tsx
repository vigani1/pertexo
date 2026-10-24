import { WebhookTestListener } from '@/features/workflow-publish/webhook-tests.public';
import { useNavigate } from '@tanstack/react-router';
import type { CodeSettings } from '@pertexo/node-sdk';
import {
  stepSampleIdentity,
  WORKFLOW_FAILURE_PORT,
} from '@pertexo/workflow-model';
import { FailureSetup } from '../failure-routing/setup';
import type { ReactNode } from 'react';
import type {
  NodeDefinitionCatalogItem,
  ConnectionResponse,
  WorkflowGraphContract,
} from '@pertexo/contracts';
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
import { useEditorStore, useEditorStoreApi } from '../../model/state/context';
import { stepTitle } from '../../model/graph/adapter';
import { linkWorkflowNodes } from '../../model/graph/commands';
import { findStep, levelOf } from '../../model/graph/scopes';
import { inlineOutputBytes } from '../../model/step-card';
import type { useEditorActions } from '../../hooks/use-editor-actions';
import { InspectorPanel } from './panel';
import type { ChannelLookupScope } from './fields/slack-channel-field';
import type { InspectorTab } from '../../hooks/use-inspector-navigation';
import type { NodeInspectorActions } from './node';
import type { FinishedTest } from '../../hooks/use-last-test';

type PassedTest = Readonly<{ previewId: string; nodeId: string }>;

/**
 * The inspector lens wired to the editor: step commands go through the
 * guarded actions, and the Test tab remembers the last passed test so the
 * next step can reuse its output.
 */
type EditorInspectorProps = Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workspaceName: string;
  workflowId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  codeSettings?: CodeSettings | undefined;
  connections: readonly ConnectionResponse[];
  userId: string;
  /** A step's record in real runs, for the Runs tab. */
  renderStepRuns?: (nodeId: string, stepLabel: string) => ReactNode;
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
  /** The test that finished last, shown again on its step's Test tab. */
  rememberedTest: FinishedTest | undefined;
  onTestFinished: (test: FinishedTest) => void;
  onTestPassed: (nodeId: string, outputBytes: number | undefined) => void;
  onClose: () => void;
  onAddStepAfter: (nodeId: string, returnFocus: HTMLElement | null) => void;
  onAddFailureHandler: (nodeId: string, opener: HTMLElement) => void;
  onAddToBody: (loopId: string, returnFocus: HTMLElement) => void;
  onDuplicateSelection: () => void;
  onRemoveEdge: (edgeId: string) => void;
}>;

export function EditorInspector({
  apiClient,
  workspaceId,
  workspaceName,
  workflowId,
  definitions,
  codeSettings,
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
  rememberedTest,
  onTestFinished,
  onTestPassed,
  onClose,
  onAddStepAfter,
  onAddFailureHandler,
  onAddToBody,
  onDuplicateSelection,
  onRemoveEdge,
  renderStepRuns,
}: EditorInspectorProps) {
  const store = useEditorStoreApi();
  const navigate = useNavigate();
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
      codeSettings={codeSettings}
      connections={connections}
      channelLookup={channelLookup}
      callScope={{ apiClient, userId, workspaceId, workflowId }}
      workspaceScope={{ apiClient, userId, workspaceId }}
      editable={editable}
      scratchVersion={actions.scratchVersion}
      tab={tab}
      onTabChange={onTabChange}
      focusTarget={actions.focusTarget}
      renderFailureSetup={(node) => (
        <FailureSetup
          node={node}
          graph={graph}
          definitions={definitions}
          editable={editable}
          store={store}
          onAdd={onAddFailureHandler}
          onRemove={onRemoveEdge}
          onSelect={(nodeId) => {
            actions.request({ kind: 'select', nodeIds: [nodeId] });
          }}
        />
      )}
      {...(renderStepRuns === undefined ? {} : { renderRuns: renderStepRuns })}
      actions={inspectorActions({
        store,
        navigate,
        selectedNodeId,
        copyStepId,
        workspaceId,
        workflowId,
        actions,
        onAddStepAfter,
        onDuplicateSelection,
        onClose,
        onRemoveEdge,
        onAddToBody,
      })}
      renderTest={(nodeId, stepSideEffect) => (
        <NodeTestPanel
          apiClient={apiClient}
          userId={userId}
          editable={editable}
          stepBinding={sampleBinding(findStep(graph, nodeId))}
          liveTestUnavailable={previewUnavailable(findStep(graph, nodeId))}
          workspaceId={workspaceId}
          workflowId={workflowId}
          nodeId={nodeId}
          stepSideEffect={stepSideEffect}
          priorPreview={priorTestFor(graph, passedTest, nodeId)}
          rememberedPreview={
            rememberedTest?.nodeId === nodeId
              ? rememberedTest.preview
              : undefined
          }
          ensureSaved={ensureSaved}
          actionRef={testRef}
          onFinished={(preview) => {
            onTestFinished({ nodeId, preview });
          }}
          onSucceeded={(preview) => {
            setPassedTest({ previewId: preview.id, nodeId });
            onTestPassed(nodeId, inlineOutputBytes(preview.output));
          }}
        >
          {editable &&
          findStep(graph, nodeId)?.definition.key === 'core.webhook' ? (
            <WebhookTestListener
              scope={{ apiClient, userId, workspaceId, workflowId }}
              nodeId={nodeId}
              binding={sampleBinding(findStep(graph, nodeId))}
              ensureSaved={ensureSaved}
              active={tab === 'test'}
            />
          ) : null}
        </NodeTestPanel>
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
      edge.source.nodeId === passed.nodeId &&
      edge.target.nodeId === nodeId &&
      edge.source.port !== WORKFLOW_FAILURE_PORT,
  );
  const source = findStep(graph, passed.nodeId);
  return (wired ?? false) && source !== undefined
    ? { id: passed.previewId, stepName: stepTitle(source) }
    : undefined;
}

function sampleBinding(node: ReturnType<typeof findStep>): string | undefined {
  return node === undefined ? undefined : stepSampleIdentity(node);
}
function previewUnavailable(
  node: ReturnType<typeof findStep>,
): string | undefined {
  if (node?.definition.key === 'core.approval')
    return 'Run the workflow to create an approval, then decide it in Approvals. A real preview cannot pause for a human decision.';
  if (node?.definition.key === 'core.call')
    return 'Run this workflow to test the Call with its child. A real single-step preview cannot return a child result.';
  if (
    Object.values(node?.inputMappings ?? {}).some(
      (source) => source.kind === 'node_failure',
    )
  )
    return 'This handler reads an actual failure. Run the workflow to verify its failure path; a real single-step preview cannot supply that evidence.';
  return undefined;
}

function inspectorActions({
  store,
  navigate,
  selectedNodeId,
  copyStepId,
  workspaceId,
  workflowId,
  actions,
  onAddStepAfter,
  onDuplicateSelection,
  onClose,
  onRemoveEdge,
  onAddToBody,
}: Readonly<
  Pick<
    EditorInspectorProps,
    | 'workspaceId'
    | 'workflowId'
    | 'actions'
    | 'onAddStepAfter'
    | 'onDuplicateSelection'
    | 'onClose'
    | 'onRemoveEdge'
    | 'onAddToBody'
  > & {
    store: ReturnType<typeof useEditorStoreApi>;
    navigate: ReturnType<typeof useNavigate>;
    selectedNodeId: string | null;
    copyStepId: () => void;
  }
>): NodeInspectorActions {
  return {
    onAddAfter: (returnFocus) => {
      if (selectedNodeId !== null) onAddStepAfter(selectedNodeId, returnFocus);
    },
    onDuplicate: onDuplicateSelection,
    onCopyId: copyStepId,
    onDiscuss: () => {
      if (selectedNodeId !== null)
        void navigate({
          to: '/w/$workspaceId/workflows/$workflowId/comments',
          params: { workspaceId, workflowId },
          search: { step: selectedNodeId },
        });
    },
    onDelete: () => {
      if (selectedNodeId !== null)
        actions.request({
          kind: 'delete',
          nodeIds: [selectedNodeId],
          edgeIds: [],
        });
    },
    onClose,
    onConnect: (link: Connection) => {
      const state = store.getState();
      const next = linkWorkflowNodes(state.graph, link);
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
  };
}
