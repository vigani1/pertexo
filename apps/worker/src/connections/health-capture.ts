import type { NodeConnectionHealthObservation } from '@pertexo/node-sdk/server';

const REAUTHORIZATION_FIELDS = Object.freeze(['kind', 'reasonCode']);

const reasons = new Set([
  'connection.slack_account_inactive',
  'connection.slack_token_expired',
  'connection.slack_token_revoked',
]);

/** No I/O and no exceptions: provider outcome handling is independent. */
export function createConnectionHealthCapture(wasDispatched: () => boolean) {
  let observation: NodeConnectionHealthObservation | undefined;
  let conflicting = false;
  return Object.freeze({
    observe: (value: NodeConnectionHealthObservation): void => {
      if (!wasDispatched() || conflicting) return;
      try {
        const keys = Object.keys(value);
        let next: NodeConnectionHealthObservation;
        if (value.kind === 'healthy' && keys.length === 1 && keys[0] === 'kind')
          next = Object.freeze({ kind: 'healthy' });
        else {
          const validReauthorizationObservation =
            value.kind === 'reauthorization_required' &&
            keys.length === REAUTHORIZATION_FIELDS.length &&
            REAUTHORIZATION_FIELDS.every((field) => keys.includes(field)) &&
            reasons.has(value.reasonCode);
          if (validReauthorizationObservation)
            next = Object.freeze({
              kind: 'reauthorization_required',
              reasonCode: value.reasonCode,
            });
          else return;
        }
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
