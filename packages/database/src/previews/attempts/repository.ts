import type { PreviewAttemptRunStore } from './contract.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import type { DatabaseConfig } from '../../config.js';
import { z } from 'zod';
import { claimPreviewDelivery } from './claim.repository.js';
import { completePreviewAttempt } from './completion.repository.js';
import { markPreviewDispatched } from './dispatch.repository.js';
import { heartbeatPreviewLease } from './heartbeat.repository.js';

const leaseScopeSchema = z.object({
  attemptFenceToken: z.number().int().nonnegative(),
  previewAttemptId: z.uuid(),
  previewRunId: z.uuid(),
  workspaceId: z.uuid(),
});

function leaseAuthority(lease: unknown) {
  return Object.freeze(leaseScopeSchema.parse(lease));
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
