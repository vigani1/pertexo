/** A workflow whose failure streak reached its threshold in this fold. */
export type WorkflowTriggerPauseDecision = Readonly<{
  workspaceId: string;
  workflowId: string;
  consecutiveFailures: number;
}>;

export interface WorkflowTriggerPauseFoldStore {
  /** Fails unless the fold command is the reviewed one. */
  checkReadiness(signal?: AbortSignal): Promise<void>;
  /**
   * Folds up to `limit` pending run outcomes into their workflows' streaks,
   * pausing workflows that reach their threshold.
   */
  foldPending(
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly WorkflowTriggerPauseDecision[]>;
  close(): Promise<void>;
}
