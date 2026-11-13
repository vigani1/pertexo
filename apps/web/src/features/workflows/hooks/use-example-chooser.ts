import {
  CURATED_WORKFLOW_TEMPLATES,
  FIRST_RUN_TEMPLATE_ID,
} from '@pertexo/templates';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { startsInOneClick, useStartExample } from './use-start-example';

/**
 * Choosing an example: one with nothing to set up starts at once and opens
 * in Build (the first-run example with its guide); the rest, one this
 * workspace can't build as is, or any choice while an import is still
 * unresolved, open the import dialog.
 */
export function useExampleChooser(
  {
    apiClient,
    userId,
    workspace,
  }: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: Readonly<{ id: string }>;
  }>,
  {
    importHeld,
    onCreated,
    onReview,
  }: Readonly<{
    /** An unresolved import keeps the dialog: choosing reopens it. */
    importHeld: boolean;
    onCreated: (workflowId: string, guided: boolean) => void;
    onReview: (templateId: string, name: string) => void;
  }>,
) {
  const notifications = useNotifications();
  const starter = useStartExample({
    apiClient,
    userId,
    workspaceId: workspace.id,
    onCreated: (workflowId, template) => {
      onCreated(workflowId, template.templateId === FIRST_RUN_TEMPLATE_ID);
    },
    onNeedsReview: (template) => {
      onReview(template.templateId, '');
    },
  });

  function choose(templateId: string, name = '') {
    const template = CURATED_WORKFLOW_TEMPLATES.find(
      (candidate) => candidate.templateId === templateId,
    );
    if (importHeld || template === undefined || !startsInOneClick(template)) {
      onReview(templateId, name);
      return;
    }
    void starter.start(template, name).then((failure) => {
      if (failure === undefined) return;
      notifications.error({
        title: `${template.title} didn’t start`,
        description: failure,
        action: {
          label: 'Try again',
          onClick: () => {
            choose(templateId, name);
          },
        },
      });
    });
  }

  return { choose, starting: starter.starting };
}
