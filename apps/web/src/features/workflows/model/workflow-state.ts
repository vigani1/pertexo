import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import type { StatusTone } from '@/components/ui/status';

export type WorkflowState = Readonly<{ tone: StatusTone; label: string }>;

/**
 * One word for a workflow's combined lifecycle, publication and activation:
 * Draft, Live, Starting, Stopping, Degraded, Error or Archived.
 */
export function describeWorkflowState(
  workflow: Pick<
    WorkflowSummary,
    'lifecycleStatus' | 'activationStatus' | 'publishedVersionId'
  >,
): WorkflowState {
  if (workflow.lifecycleStatus === 'archived')
    return workflow.activationStatus === 'deactivating'
      ? { tone: 'waiting', label: 'Stopping' }
      : { tone: 'canceled', label: 'Archived' };
  if (workflow.publishedVersionId === null)
    return { tone: 'neutral', label: 'Draft' };
  switch (workflow.activationStatus) {
    case 'active':
    case 'inactive':
      return { tone: 'success', label: 'Live' };
    case 'activating':
      return { tone: 'live', label: 'Starting' };
    case 'deactivating':
      return { tone: 'waiting', label: 'Stopping' };
    case 'degraded':
      return { tone: 'attention', label: 'Degraded' };
    case 'error':
      return { tone: 'failure', label: 'Error' };
  }
}
