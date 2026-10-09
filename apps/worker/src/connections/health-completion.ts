import type { NodeConnectionHealthObservation } from '@pertexo/node-sdk/server';
import type { ConnectionRunHealthMode } from '../config/connection-health.js';

/** Forward captured evidence only through the accepted completion transaction. */
export function connectionHealthCompletionFields(
  dependencies: Readonly<{ connectionRunHealthMode?: ConnectionRunHealthMode }>,
  environment:
    | Readonly<{
        connectionHealthObservation():
          NodeConnectionHealthObservation | undefined;
      }>
    | undefined,
) {
  const observation = environment?.connectionHealthObservation();
  return observation === undefined
    ? {}
    : {
        connectionHealthObservation: observation,
        connectionRunHealthMode: dependencies.connectionRunHealthMode ?? 'off',
      };
}
