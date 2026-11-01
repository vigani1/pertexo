import type {
  NodeConnectionRuntime,
  ResolvedHttpCredential,
} from '@pertexo/node-sdk/server';

/** A step's connection that sends these headers, as a real header connection would. */
export function headerConnection(
  connectionId: string,
  secretVersionId: string,
  headers: Readonly<Record<string, string>>,
): NodeConnectionRuntime {
  const credential: ResolvedHttpCredential = {
    connectionId,
    providerKey: 'http',
    authType: 'http_headers',
    secretVersionId,
    secret: Buffer.from(JSON.stringify({ type: 'http_headers', headers })),
  };
  return {
    resolve: () => Promise.resolve(credential),
    resolveHttpCredential: () => Promise.resolve(credential),
    assertCurrent: () => Promise.resolve(),
  };
}
