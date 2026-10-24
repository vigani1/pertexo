import { useEditorSession } from '../model/state/context';

import type { Ref } from 'react';

import { PinRecordedOutputButton } from '@/features/workflow-publish/step-samples.public';
import type { NodeTestHandle } from '@/features/workflow-publish/public';
import { StepHistoryPanel } from '@/features/workflow-runs/step-history.public';

import type { useLastTest } from '../hooks/use-last-test';
import type { useStepAdding, useSelectionCommands } from './workspace-canvas';
import { EditorInspector } from './inspector/editor';

type WorkspaceInspectorProps = Readonly<{
  editable: boolean;
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
  editable,
  testing,
  canvas,
}: WorkspaceInspectorProps) {
  const { scope, editing } = useEditorSession();
  const { apiClient, userId, workspace, workflowId } = scope;
  const { actions, ensureSaved } = editing;
  const { testRef, lastTest, onTestPassed } = testing;
  const { navigation, request } = actions;
  const { setMobilePanel } = navigation;
  const {
    adding: { addAfter, addToBody, quickAdd },
    selection: { duplicateSelection, removeEdge },
  } = canvas;
  return (
    <EditorInspector
      editable={editable}

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

      testing={{
        testRef: testRef,
        rememberedTest: lastTest.last,
        onTestFinished: lastTest.record,
        onTestPassed: onTestPassed,
      }}
      navigation={{
        tab: navigation.tab,
        onTabChange: navigation.setTab,
        onClose: () => {
          setMobilePanel('none');
          request({ kind: 'select', nodeIds: [] });
        },
        onAddStepAfter: addAfter,
        onAddFailureHandler: quickAdd.openFailure,
        onAddToBody: addToBody,
        onDuplicateSelection: duplicateSelection,
        onRemoveEdge: removeEdge,
      }}
    />
  );
}
