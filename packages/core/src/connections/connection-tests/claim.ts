import { z } from 'zod';

import type { ConnectionTestOutcome } from '../contract.js';

/** A claim that hasn't moved in this long lost its request, so a retry may take it over. */
export const CONNECTION_TEST_CLAIM_STALE_SECONDS = 120;

const healthRevisionSchema = z.string().regex(/^[1-9][0-9]*$/u);

/** A definite answer from the provider can't exist unless the request went out. */
export function completionNeedsDispatchEvidence(
  outcome: ConnectionTestOutcome,
): boolean {
  return (
    outcome.ok || outcome.httpStatus !== null || outcome.reauthorizationRequired
  );
}

export function connectionTestClaim(
  dispatchToken: string,
  state: 'claimed' | 'dispatched',
  secretVersionId?: string,
  healthRevision?: string,
) {
  const base = {
    dispatchToken: dispatchToken,
  };
  if (state === 'claimed' && secretVersionId === undefined)
    return Object.freeze({ ...base, state });
  return Object.freeze({
    ...base,
    state,
    secretVersionId: secretVersionId,
    ...(healthRevision === undefined
      ? {}
      : { healthRevision: healthRevisionSchema.parse(healthRevision) }),
  });
}

export const connectionTestClaimSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('claimed'),
      dispatchToken: z.uuid(),
      secretVersionId: z.uuid().optional(),
      healthRevision: healthRevisionSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('dispatched'),
      dispatchToken: z.uuid(),
      // Optional only for already-persisted version-1 in-flight claims.
      secretVersionId: z.uuid().optional(),
      healthRevision: healthRevisionSchema.optional(),
    })
    .strict(),
]);
