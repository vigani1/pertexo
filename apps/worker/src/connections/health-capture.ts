import type { NodeConnectionHealthObservation } from '@pertexo/node-sdk/server';

const reasons = new Set([
  'connection.slack_account_inactive',
  'connection.slack_token_expired',
  'connection.slack_token_revoked',
]);

/** No I/O and no exceptions: provider outcome handling is independent. */
export function createConnectionHealthCapture(
  enabled: boolean,
  wasDispatched: () => boolean,
) {
  let observation: NodeConnectionHealthObservation | undefined;
  let conflicting = false;
  return Object.freeze({
    observe: (value: NodeConnectionHealthObservation): void => {
      if (!enabled || !wasDispatched() || conflicting) return;
      try {
        const keys = Object.keys(value);
        let next: NodeConnectionHealthObservation;
        if (value.kind === 'healthy' && keys.length === 1 && keys[0] === 'kind')
          next = Object.freeze({ kind: 'healthy' });
        else if (
          value.kind === 'reauthorization_required' &&
          keys.length === 2 &&
          keys.includes('kind') &&
          keys.includes('reasonCode') &&
          reasons.has(value.reasonCode)
        )
          next = Object.freeze({
            kind: 'reauthorization_required',
            reasonCode: value.reasonCode,
          });
        else return;
        if (
          observation !== undefined &&
          JSON.stringify(observation) !== JSON.stringify(next)
        ) {
          conflicting = true;
          observation = undefined;
          return;
        }
        observation = next;
      } catch {
        // A malformed runtime caller cannot alter the provider result.
      }
    },
    read: (): NodeConnectionHealthObservation | undefined => observation,
  });
}
