import type { PoolClient } from 'pg';

/** Deletes a workspace's stored objects, one page per call. */
export interface WorkspacePurgeObjectStore {
  purgeWorkspacePage(input: {
    readonly maxObjects: number;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<{
    readonly completed: boolean;
    readonly deletedCount: number;
  }>;
}

export type WorkspacePurgeProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'started' | 'completed'; workspaceId: string }>
  | Readonly<{
      status: 'progressed';
      workspaceId: string;
      /** The purge step that changed rows, or `objects`. */
      step: string;
    }>;

/** One bounded change to a purging workspace's rows. */
export type PurgeStep = Readonly<{
  name: string;
  run(
    client: PoolClient,
    workspaceId: string,
    pageSize: number,
  ): Promise<number>;
}>;
