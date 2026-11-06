import { slackRejection } from './rejection-policy.js';
import type { NodeConnectionHealthObservation } from '@pertexo/node-sdk/server';

import type { SlackClient } from './client.js';

/**
 * Classify parsed Slack evidence, not status codes or executor error kinds.
 * The client has validated success; send adapters additionally verify output
 * and the requested channel before reporting it. No provider text is retained.
 */
export function classifySlackConnectionHealth(
  result: Awaited<ReturnType<SlackClient['authTest']>>,
): NodeConnectionHealthObservation | undefined {
  if (result.kind === 'succeeded') return Object.freeze({ kind: 'healthy' });
  if (result.kind !== 'rejected') return undefined;
  const policy = slackRejection(result.error);
  return policy !== undefined && 'health' in policy
    ? Object.freeze(policy.health)
    : undefined;
}
