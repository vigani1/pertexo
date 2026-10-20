import { Link } from '@tanstack/react-router';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Status } from '@/components/ui/status';
import { describeWorkflowState } from '../../model/state';

/** An endpoint needs a builder's action; it is not background activation. */
export function WorkflowActivationState({
  workspace,
  workflowId,
  workflow,
  activeTab,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  activeTab: string;
}>) {
  const activating =
    workflow?.activationStatus === 'activating' &&
    workflow.lifecycleStatus === 'active';
  if (workflow === undefined) return null;
  const needsSetup = activating && workflow.webhookSetupRequired;
  const state = describeWorkflowState(workflow);
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
