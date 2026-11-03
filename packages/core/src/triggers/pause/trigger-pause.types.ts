/** A workflow whose failure streak reached its threshold in this fold. */
export type WorkflowTriggerPauseDecision = Readonly<{
  workspaceId: string;
  workflowId: string;
  consecutiveFailures: number;
}>;
