import type {
  AccessibleWorkspace,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { SettingsSection } from '@/components/patterns/settings-section';
import { describeStep } from '@/features/catalog/presentation.public';
import { workflowDraftQueryOptions } from '@/features/workflow-editor/draft.public';
import { StepHealthList } from '@/features/workflow-runs/step-history.public';
import type { ApiClient } from '@/lib/api/client';

type GraphLevel = Readonly<Pick<WorkflowGraphContract, 'nodes' | 'edges'>>;

/** Each step's name as Build shows it, on every level of the graph. */
function stepNames(graph: GraphLevel | undefined): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const visit = (level: GraphLevel) => {
    for (const node of level.nodes) {
      const label = node.label?.trim();
      names.set(
        node.id,
        label === undefined || label === ''
          ? describeStep(node.definition.key).name
          : label,
      );
      if (node.structured !== undefined) visit(node.structured.body);
    }
  };
  if (graph !== undefined) visit(graph);
  return names;
}

/**
 * How each step has done across the workflow's last 100 runs, the ones that
 * fail most first, named as the draft names them.
 */
export function StepHealthSection({
  apiClient,
  userId,
  workspace,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>) {
  const draft = useQuery(
    workflowDraftQueryOptions(apiClient, userId, workspace.id, workflowId),
  );
  const names = useMemo(() => stepNames(draft.data?.draft.graph), [draft.data]);
  return (
    <SettingsSection
      title="Steps"
      description="How each step has done in this workflow’s last 100 runs, the ones that fail most first."
    >
      <StepHealthList
        apiClient={apiClient}
        userId={userId}
        workspace={workspace}
        workflowId={workflowId}
        labelOf={(nodeId) => names.get(nodeId)}
      />
    </SettingsSection>
  );
}
