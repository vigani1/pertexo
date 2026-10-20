import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type {
  AccessibleWorkspace,
  WorkflowSummary,
  WebhookTriggerHealthResponse,
} from '@pertexo/contracts';
import { Status } from '@/components/ui/status';
import { webhookTriggersQueryOptions } from '@/features/workflow-settings/triggers.queries.public';
import type { ApiClient } from '@/lib/api/client';
import { describeWorkflowState } from '../../model/state';

/** An endpoint needs a builder's action; it is not background activation. */
export function WorkflowActivationState({
  apiClient,
  userId,
  workspace,
  workflowId,
  workflow,
  activeTab,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  activeTab: string;
}>) {
  const activating =
    workflow?.activationStatus === 'activating' &&
    workflow.lifecycleStatus === 'active';
  const webhooks = useQuery({
    ...webhookTriggersQueryOptions(apiClient, userId, workspace.id, workflowId),
    enabled: activating && workspace.capabilities.includes('workflow:update'),
    refetchInterval: (query) =>
      activating &&
      !needsWebhookSetup(workflow.publishedVersionId, query.state.data?.items)
        ? 5000
        : false,
  });
  if (workflow === undefined) return null;
  const needsSetup =
    activating &&
    needsWebhookSetup(workflow.publishedVersionId, webhooks.data?.items);
  const state = needsSetup
    ? { tone: 'attention' as const, label: 'Trigger needs setup' }
    : describeWorkflowState(workflow);
  const word = (
    <Status tone={state.tone} className="font-sans text-[0.75rem]">
      {state.label}
    </Status>
  );
  return activating && activeTab !== 'triggers' ? (
    <Link
      to="/w/$workspaceId/workflows/$workflowId/triggers"
      params={{ workspaceId: workspace.id, workflowId }}
      aria-label={
        needsSetup
          ? 'Trigger needs setup — open Triggers'
          : 'Starting — check triggers'
      }
      className="inline-link rounded-sm focus-ring"
    >
      {word}
    </Link>
  ) : (
    word
  );
}

function needsWebhookSetup(
  versionId: string | null | undefined,
  triggers: readonly WebhookTriggerHealthResponse[] | undefined,
): boolean {
  return (
    triggers?.some(
      (trigger) =>
        trigger.workflowVersionId === versionId && !trigger.endpointReady,
    ) ?? false
  );
}
