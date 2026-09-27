import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/database-runtime.js';
import type { DatabaseConfig } from '../../config.js';
import { z } from 'zod';
import { claimPreviewDelivery } from './preview-execution-claim.js';
import { completePreviewAttempt } from './preview-execution-completion.js';
import { markPreviewDispatched } from './preview-execution-dispatch.js';
import { heartbeatPreviewLease } from './preview-execution-heartbeat.js';

const leaseScopeSchema = z.object({
  attemptFenceToken: z.number().int().nonnegative(),
  previewAttemptId: z.uuid(),
  previewRunId: z.uuid(),
  workspaceId: z.uuid(),
});

function leaseAuthority(lease: unknown) {
  return Object.freeze(leaseScopeSchema.parse(lease));
}

export interface PreviewAttemptRunStore {
  claim(
    input: Parameters<typeof claimPreviewDelivery>[1],
  ): ReturnType<typeof claimPreviewDelivery>;
  markDispatched(
    input: Parameters<typeof markPreviewDispatched>[1],
  ): ReturnType<typeof markPreviewDispatched>;
  heartbeat(
    input: Parameters<typeof heartbeatPreviewLease>[1],
  ): ReturnType<typeof heartbeatPreviewLease>;
  complete(
    input: Parameters<typeof completePreviewAttempt>[1],
  ): ReturnType<typeof completePreviewAttempt>;
}

/** The store owns its pool lease; injected runtimes retain their own lifetime. */
export function createDatabasePreviewAttemptRunStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): PreviewAttemptRunStore & { close(): Promise<void> } {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    claim: (input: Parameters<PreviewAttemptRunStore['claim']>[0]) =>
      claimPreviewDelivery(pool, input),
    markDispatched: async (
      input: Parameters<PreviewAttemptRunStore['markDispatched']>[0],
    ) =>
      markPreviewDispatched(pool, {
        ...input,
        lease: leaseAuthority(input.lease),
      }),
    heartbeat: async (
      input: Parameters<PreviewAttemptRunStore['heartbeat']>[0],
    ) =>
      heartbeatPreviewLease(pool, {
        ...input,
        lease: leaseAuthority(input.lease),
      }),
    complete: async (
      input: Parameters<PreviewAttemptRunStore['complete']>[0],
    ) =>
      completePreviewAttempt(pool, {
        ...input,
        lease: leaseAuthority(input.lease),
      }),
    close: () => lease.close(),
  });
}
