import type { ConnectionLookupResponse } from '@pertexo/contracts';
import {
  withProviderCredential,
  type ConnectionWithSecret,
} from '@pertexo/node-sdk/server';
import type { z } from 'zod';
import type { ProviderHttpClient } from './http-client.js';

type LookupContext = Readonly<{
  connection: ConnectionWithSecret;
  connectionId: string;
  providerKey: string;
  signal: AbortSignal;
  http: Pick<ProviderHttpClient, 'executeStreaming'>;
  refuse(): Error;
}>;

export type ConnectionLookup = Readonly<{
  key: string;
  authType: string;
  prepare(
    input: unknown,
  ):
    ((context: LookupContext) => Promise<ConnectionLookupResponse>) | undefined;
}>;

export function defineConnectionLookup<
  Input extends z.ZodType,
  Credential extends z.ZodType,
>(
  definition: Readonly<{
    key: string;
    authType: string;
    inputSchema: Input;
    credentialSchema: Credential;
    discover(
      input: z.output<Input>,
      credential: z.output<Credential>,
      context: Pick<LookupContext, 'signal' | 'http'>,
    ): Promise<ConnectionLookupResponse>;
  }>,
): ConnectionLookup {
  return {
    key: definition.key,
    authType: definition.authType,
    prepare(input) {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) return undefined;
      return (context) =>
        withProviderCredential(
          context.connection,
          {
            connectionId: context.connectionId,
            providerKey: context.providerKey,
            authTypes: [definition.authType],
            schema: definition.credentialSchema,
            refuse: context.refuse,
          },
          (credential) =>
            definition.discover(parsed.data, credential, {
              signal: context.signal,
              http: context.http,
            }),
        );
    },
  };
}
