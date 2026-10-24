/** A workspace whose inbox changed, with its newest thread revision. */
export type WorkspaceInboxChange = Readonly<{
  workspaceId: string;
  revision: string;
}>;

export interface WorkspaceInboxFoldStore {
  /** Fails unless the database is at the expected migration. */
  checkReadiness(signal?: AbortSignal): Promise<void>;
  /** Folds up to `limit` pending failures into their workflows' threads. */
  foldPending(
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceInboxChange[]>;
  observeCurrent?(
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceInboxChange[]>;
  close(): Promise<void>;
}
