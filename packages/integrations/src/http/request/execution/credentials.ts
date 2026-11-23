import { httpHeadersCredentialSchema } from '@pertexo/contracts';
import {
  withProviderCredential,
  type ResolvedNodeConnection,
  type ResolvedHttpCredential,
} from '@pertexo/node-sdk/server';
import {
  failedConfiguration,
  HttpRequestExecutorError,
} from '../request.errors.js';

export const HTTP_REQUEST_CREDENTIAL_PURPOSE = 'http.request.execute';

export async function withHttpCredentialHeaders<T>(
  resolved: ResolvedNodeConnection | ResolvedHttpCredential | undefined,
  connectionId: string | undefined,
  run: (headers?: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  if (resolved === undefined || 'accessToken' in resolved) return run();
  return withProviderCredential(
    resolved,
    {
      connectionId: connectionId ?? '',
      providerKey: 'http',
      authTypes: ['http_headers'],
      schema: httpHeadersCredentialSchema,
      refuse: (reason) =>
        reason === 'configuration'
          ? failedConfiguration()
          : new HttpRequestExecutorError(
              Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
              { possiblyDispatched: false },
            ),
    },
    (credential) => run(credential.headers),
  );
}

/** A service can echo a token without its scheme, so both forms are secret. */
export function credentialSensitiveValues(
  headers: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.values(headers).flatMap((value) => {
    const token = /^\S+\s+(\S{8,})$/u.exec(value)?.[1];
    return token === undefined ? [value] : [value, token];
  });
}
