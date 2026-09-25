import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import { statusToneText } from '@/components/ui/status-tone';
import { describeWorkflowState } from '@/features/workflows/hub.public';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { liveVersionQueryOptions } from '../../workflow-editor.queries';

/**
 * The number of the version that runs, after the state word: "Live v4".
 * Nothing while it's unknown, for drafts that were never published, or
 * once the workflow is archived.
 */
export function LiveVersion({
  apiClient,
  userId,
  workspaceId,
  workflow,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflow: WorkflowSummary | undefined;
}>) {
  const versionId =
    workflow?.lifecycleStatus === 'active' ? workflow.publishedVersionId : null;
  const version = useQuery({
    ...liveVersionQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflow?.id ?? '',
      versionId ?? '',
    ),
    enabled: versionId !== null,
  });
  if (
    workflow === undefined ||
    versionId === null ||
    version.data === undefined
  )
    return null;
  // In the state word's colour, so it reads as one phrase: "Live v4".
  const { tone } = describeWorkflowState(workflow);
  return (
    <span className={cn('-ml-1.5', statusToneText[tone])}>
      v{version.data.versionNumber}
    </span>
  );
}
