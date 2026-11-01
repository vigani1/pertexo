import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { claimPreviewDelivery } from './claim.js';
import { completePreviewAttempt } from './complete.js';
import type {
  ClaimPreviewDeliveryInput,
  CompletePreviewAttemptInput,
  HeartbeatPreviewLeaseInput,
  MarkPreviewDispatchedInput,
} from './contract.js';
import { heartbeatPreviewLease } from './heartbeat.js';
import { markPreviewDispatched } from './mark-dispatched.js';

/**
 * A preview worker has a claim and a fence token, not a member, so these flows
 * stay off withWorkspaceAccess. The member's authority was checked when the
 * preview was accepted. The store owns its pool lease; injected runtimes retain
 * their own lifetime.
 */
export function createPreviewAttemptRunStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    claim: (input: ClaimPreviewDeliveryInput) =>
      claimPreviewDelivery(pool, input),
    markDispatched: (input: MarkPreviewDispatchedInput) =>
      markPreviewDispatched(pool, input),
    heartbeat: (input: HeartbeatPreviewLeaseInput) =>
      heartbeatPreviewLease(pool, input),
    complete: (input: CompletePreviewAttemptInput) =>
      completePreviewAttempt(pool, input),
    close: () => lease.close(),
  });
}
