import type { PoolClient } from 'pg';
import { z } from 'zod';

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

export /** One bounded change to a purging workspace's rows. */
type PurgeStep = Readonly<{
  name: string;
  run(
    client: PoolClient,
    workspaceId: string,
    pageSize: number,
  ): Promise<number>;
}>;

export const optionsSchema = z
  .object({
    lockTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    objectPageSize: z.number().int().min(1).max(1_000).default(500),
    objectTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    pageSize: z.number().int().min(1).max(1_000).default(500),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
  })
  .strict();

export type WorkspacePurgeOptions = z.input<typeof optionsSchema>;
