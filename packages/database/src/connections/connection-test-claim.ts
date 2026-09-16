import { z } from 'zod';

import { uuidSchema } from './connection-persistence.js';

export function connectionTestScope(
  actorId: string,
  connectionId: string,
): string {
  return `${uuidSchema.parse(actorId)}:${uuidSchema.parse(connectionId)}`;
}

export function connectionTestClaim(
  dispatchToken: string,
  state: 'claimed' | 'dispatched',
  secretVersionId?: string,
) {
  const base = {
    schemaVersion: 1 as const,
    dispatchToken: uuidSchema.parse(dispatchToken),
  };
  if (state === 'claimed') return Object.freeze({ ...base, state });
  return Object.freeze({
    ...base,
    state,
    secretVersionId: uuidSchema.parse(secretVersionId),
  });
}

export const connectionTestClaimSchema = z.discriminatedUnion('state', [
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal('claimed'),
      dispatchToken: z.uuid(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal('dispatched'),
      dispatchToken: z.uuid(),
      // Optional only for already-persisted version-1 in-flight claims.
      secretVersionId: z.uuid().optional(),
    })
    .strict(),
]);
