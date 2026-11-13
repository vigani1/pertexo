import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import {
  CURATED_WORKFLOW_TEMPLATES,
  FIRST_RUN_TEMPLATE_ID,
} from '@pertexo/templates';
import { useNotifications } from '@/components/ui/use-notifications';
import {
  startsInOneClick,
  useStartExample,
} from '@/features/workflows/start-example.public';
import type { ApiClient } from '@/lib/api/client';
import type { FirstRunOffer } from '../components/first-thread';

const example = CURATED_WORKFLOW_TEMPLATES.find(
  (template) => template.templateId === FIRST_RUN_TEMPLATE_ID,
);

/**
 * The one-click guided first run, offered to a workspace with no workflows
 * to someone who can create one: it creates the example with nothing to set
 * up and hands over the new workflow.
 */
export function useFirstRunOffer({
  apiClient,
  userId,
  workspace,
  workflows,
  onCreated,
  onNeedsReview,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflows: readonly WorkflowSummary[] | undefined;
  onCreated: (workflowId: string) => void;
  onNeedsReview: () => void;
}>): FirstRunOffer | undefined {
  const notifications = useNotifications();
  const starter = useStartExample({
    apiClient,
    userId,
    workspaceId: workspace.id,
    onCreated,
    onNeedsReview,
  });
  if (
    example === undefined ||
    !startsInOneClick(example) ||
    workflows?.length !== 0 ||
    !workspace.capabilities.includes('workflow:create')
  )
    return undefined;
  return {
    starting: starter.starting !== undefined,
    onStart: () => {
      void starter.start(example).then((failure) => {
        if (failure === undefined) return;
        notifications.error({
          title: 'The example didn’t start',
          description: failure,
        });
      });
    },
  };
}
