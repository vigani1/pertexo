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
  switch (result.error) {
    case 'account_inactive':
      return Object.freeze({
        kind: 'reauthorization_required',
        reasonCode: 'connection.slack_account_inactive',
      });
    case 'token_expired':
      return Object.freeze({
        kind: 'reauthorization_required',
        reasonCode: 'connection.slack_token_expired',
      });
    case 'token_revoked':
      return Object.freeze({
        kind: 'reauthorization_required',
        reasonCode: 'connection.slack_token_revoked',
      });
    default:
      return undefined;
  }
}
