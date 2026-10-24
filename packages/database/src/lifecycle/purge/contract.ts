import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { optionsSchema } from './input.js';

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

export interface WorkspacePurgeCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<WorkspacePurgeProcessResult>;
}

/** One bounded change to a purging workspace's rows. */
export type PurgeStep = Readonly<{
  name: string;
  run(
    client: PoolClient,
    workspaceId: string,
    pageSize: number,
  ): Promise<number>;
}>;

export type WorkspacePurgeOptions = z.input<typeof optionsSchema>;
