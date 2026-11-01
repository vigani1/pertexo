import type { PreviewAttemptLease } from '../contract.js';
import type { withTenantScopedClient } from '@pertexo/database/primitives';
import type { claimPreviewDelivery } from './claim.repository.js';
import type { completePreviewAttempt } from './completion.repository.js';
import type { markPreviewDispatched } from './dispatch.repository.js';
import type { heartbeatPreviewLease } from './heartbeat.repository.js';

export type PreviewClaimResult =
  | Readonly<{ kind: 'claimed'; lease: PreviewAttemptLease }>
  | Readonly<{ kind: 'duplicate' }>;

export type PreviewHeartbeatResult = Readonly<{
  attemptLeaseExpiresAt: Date;
  runExecutionDeadlineAt: Date;
}>;

export type PreviewCompletionResult = Readonly<{
  kind: 'committed' | 'duplicate';
}>;

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

export type PreviewOutboxClient = Parameters<
  Parameters<typeof withTenantScopedClient>[2]
>[0];
