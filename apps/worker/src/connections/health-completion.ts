import type { NodeConnectionHealthObservation } from '@pertexo/node-sdk/server';

/** Forward captured evidence only through the accepted completion transaction. */
export function connectionHealthCompletionFields(
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
    : { connectionHealthObservation: observation };
}
