import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { claimPreviewDelivery } from './claim.repository.js';
import { completePreviewAttempt } from './completion.repository.js';
import type { PreviewAttemptRunStore } from './contract.js';
import { markPreviewDispatched } from './dispatch.repository.js';
import { heartbeatPreviewLease } from './heartbeat.repository.js';

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
        lease: input.lease,
      }),
    heartbeat: async (
      input: Parameters<PreviewAttemptRunStore['heartbeat']>[0],
    ) =>
      heartbeatPreviewLease(pool, {
        ...input,
        lease: input.lease,
      }),
    complete: async (
      input: Parameters<PreviewAttemptRunStore['complete']>[0],
    ) =>
      completePreviewAttempt(pool, {
        ...input,
        lease: input.lease,
      }),
    close: () => lease.close(),
  });
}
