import type {
  ConnectionTestRequest,
  ParsedConnectionCredential,
} from '@pertexo/contracts';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import type { ConnectionHttpClient } from '../ports.js';
import { responseOutcome } from './outcomes.js';

export async function testHeaderConnection(
  client: ConnectionHttpClient,
  input: Readonly<{
    request: ConnectionTestRequest;
    credential: ParsedConnectionCredential;
    method: 'GET';
    timeoutMillis: number;
    maxRedirects: number;
    maxResponseBytes: number;
    signal: AbortSignal;
    beforeDispatch(): Promise<void>;
  }>,
) {
  const { request, credential, ...limits } = input;
  if (credential.type !== 'http_headers' || !('url' in request))
    throw new ConnectionSecretEncryptionError();
  const { headers } = credential;
  const response = await client.execute({
    ...limits,
    url: request.url,
    headers,
    sensitiveValues: Object.values(headers),
  });
  try {
    return responseOutcome(response.status);
  } finally {
    response.body.fill(0);
  }
}
