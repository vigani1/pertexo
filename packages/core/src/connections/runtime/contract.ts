import type { RequestMetadata } from '../contract.js';

export type ResolveConnectionLookupSecretInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    expectedProviderKey: string;
    purpose: string;
    signal?: AbortSignal;
  }>;

/** The connection secret a run or preview was given to use. */
export type ConnectionFence = Readonly<{
  connectionId: string;
  providerKey: string;
  authType: string;
  secretVersionId: string;
}>;
