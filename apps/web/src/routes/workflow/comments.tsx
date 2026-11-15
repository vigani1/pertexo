import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { workflowNodes } from '@pertexo/workflow-model';
import { WorkflowCommentsPage } from '@/features/workflow-collaboration/pages/workflow-comments';
import { workflowDraftQueryOptions } from '@/features/workflow-editor/workflow-editor-queries.public';
import { describeStep } from '@/features/catalog/public';
import { useWorkflowHubScope } from './hub/scope';
import { WorkflowHubTabFrame } from './hub/frame';
export function WorkflowCommentsRoute() {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  const search = useSearch({
    from: '/w/$workspaceId/workflows/$workflowId/comments',
  });
  const navigate = useNavigate();
  const draft = useQuery(
    workflowDraftQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const steps =
    draft.data === undefined
      ? []
      : Array.from(workflowNodes(draft.data.draft.graph), (node) => ({
          id: node.id,
          label: node.label?.trim() ?? describeStep(node.definition.key).name,
        }));
  return (
    <WorkflowHubTabFrame tab="comments">
      <WorkflowCommentsPage
        paused={workspace.status !== 'active'}
        scope={{
          apiClient,
          userId: user.id,
          workspaceId: workspace.id,
          workflowId,
        }}
        steps={steps}
        search={search}
        onNavigate={(next) =>
          void navigate({
            to: '/w/$workspaceId/workflows/$workflowId/comments',
            params: { workspaceId: workspace.id, workflowId },
            search: next,
          })
        }
      />
    </WorkflowHubTabFrame>
  );
}
