import type { WorkflowGraphContract } from '@pertexo/contracts';
import { useMemo } from 'react';
import type { useWorkflowCommandSession } from '@/features/workflow-publish/public';
import {
  workflowIssuesView,
  type WorkflowIssue,
} from '@/features/workflow-publish/public';

/** The latest check as the editor shows it, dated against the draft. */
export function useIssuesView(
  publication: ReturnType<typeof useWorkflowCommandSession>['publication'],
  graph: WorkflowGraphContract,
  draft: Readonly<{ generation: number; revision: number }>,
  connectionIssues: readonly WorkflowIssue[],
) {
  const { validation, validationPending, validationError } = publication;
  const { generation, revision } = draft;
  return useMemo(
    () =>
      workflowIssuesView(
        { validation, validationPending, validationError },
        graph,
        { generation, revision },
        connectionIssues,
      ),
    [
      generation,
      graph,
      revision,
      validation,
      validationError,
      validationPending,
      connectionIssues,
    ],
  );
}
