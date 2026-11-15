import type { z } from 'zod';
import type { NodeExecutionRuntime } from './node-execution.types.js';

export type ResolvedProviderConnection = Awaited<
  ReturnType<NonNullable<NodeExecutionRuntime['connections']>['resolve']>
>;

/** What any resolved connection that carries a secret has: its identity and the secret. */
export type ConnectionWithSecret = Readonly<{
  connectionId: string;
  providerKey: string;
  authType: string;
  secret: Uint8Array;
}>;

/** Why a resolved connection can't be used: not the one asked for, or an unreadable secret. */
export type ProviderCredentialRefusal = 'configuration' | 'authentication';

/**
 * Opens a resolved connection's secret for one piece of work. Every step
 * reads a connection secret here (a check refuses reading one anywhere
 * else), so the secret is always zeroed afterwards, whether the work
 * succeeds, fails or the credential is refused.
 */
export async function withProviderCredential<Schema extends z.ZodType, T>(
  resolved: ConnectionWithSecret,
  expected: Readonly<{
    connectionId: string;
    providerKey: string;
    authTypes: readonly string[];
    schema: Schema;
    refuse: (reason: ProviderCredentialRefusal) => Error;
  }>,
  work: (credential: z.output<Schema>) => Promise<T>,
): Promise<T> {
  const { schema, refuse } = expected;
  try {
    if (
      resolved.connectionId !== expected.connectionId ||
      resolved.providerKey !== expected.providerKey ||
      !expected.authTypes.includes(resolved.authType)
    )
      throw refuse('configuration');
    let credential: z.output<Schema>;
    try {
      credential = schema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(resolved.secret),
        ),
      );
    } catch {
      throw refuse('authentication');
    }
    return await work(credential);
  } finally {
    resolved.secret.fill(0);
  }
}
