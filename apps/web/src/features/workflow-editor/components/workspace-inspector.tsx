import type { CodeSettings } from '@pertexo/node-sdk';
import type {
  AccessibleWorkspace,
  ConnectionResponse,
  NodeDefinitionCatalogItem,
} from '@pertexo/contracts';
import type { Ref } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { PinRecordedOutputButton } from '@/features/workflow-publish/step-samples.public';
import type { NodeTestHandle } from '@/features/workflow-publish/public';
import { StepHistoryPanel } from '@/features/workflow-runs/step-history.public';
import type { useEditorActions } from '../hooks/use-editor-actions';
import type { useLastTest } from '../hooks/use-last-test';
import type { useStepAdding, useSelectionCommands } from './workspace-canvas';
import { EditorInspector } from './inspector/editor';

type WorkspaceInspectorProps = Readonly<{
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
    workflowId: string;
  }>;
  catalog: Readonly<{
    definitions: readonly NodeDefinitionCatalogItem[];
    codeSettings: CodeSettings | undefined;
    connections: readonly ConnectionResponse[];
    connectionsAvailable: boolean;
  }>;
  actions: ReturnType<typeof useEditorActions>;
  editable: boolean;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  testing: Readonly<{
    testRef: Ref<NodeTestHandle>;
    lastTest: ReturnType<typeof useLastTest>;
    onTestPassed: (nodeId: string, outputBytes: number | undefined) => void;
  }>;
  canvas: Readonly<{
    adding: ReturnType<typeof useStepAdding>;
    selection: ReturnType<typeof useSelectionCommands>;
  }>;
}>;
export function WorkspaceInspector({
  scope,
  catalog,
  actions,
  editable,
  ensureSaved,
  testing,
  canvas,
}: WorkspaceInspectorProps) {
  const { apiClient, userId, workspace, workflowId } = scope;
  const { definitions, codeSettings, connections, connectionsAvailable } =
    catalog;
  const { testRef, lastTest, onTestPassed } = testing;
  const { navigation, request } = actions;
  const { setMobilePanel } = navigation;
  const {
    adding: { addAfter, addToBody, quickAdd },
    selection: { duplicateSelection, removeEdge },
  } = canvas;
  return (
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
      editable={editable}
      tab={navigation.tab}
      onTabChange={navigation.setTab}
      actions={actions}
      ensureSaved={ensureSaved}
      testRef={testRef}
      rememberedTest={lastTest.last}
      onTestFinished={lastTest.record}
      onTestPassed={onTestPassed}
      renderStepRuns={(nodeId, stepLabel) => (
        <StepHistoryPanel
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflowId={workflowId}
          nodeId={nodeId}
          stepLabel={stepLabel}
          renderActions={(run) =>
            editable && run.status === 'succeeded' ? (
              <PinRecordedOutputButton
                scope={{
                  apiClient,
                  userId,
                  workspaceId: workspace.id,
                  workflowId,
                }}
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
  );
}
