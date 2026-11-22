import { CONNECTION_LOOKUP_LIMITS } from '@pertexo/contracts';
import {
  ProviderHttpError,
  type ProviderHttpBodyConsumer,
  type ProviderHttpClient,
  type ProviderHttpRequest,
} from '@pertexo/integrations/server';

export type LookupHttp = Pick<
  ProviderHttpClient,
  'execute' | 'executeStreaming'
>;

export function boundedLookupHttp(
  http: LookupHttp,
  signal: AbortSignal,
  beforeDispatch: () => Promise<void>,
): LookupHttp {
  let remainingBytes: number = CONNECTION_LOOKUP_LIMITS.bytes;
  let remainingExchanges: number = CONNECTION_LOOKUP_LIMITS.exchanges;

  const bounded = (request: ProviderHttpRequest): ProviderHttpRequest => {
    signal.throwIfAborted();
    if (remainingExchanges <= 0 || remainingBytes <= 0)
      throw budgetExceeded(false);
    remainingExchanges -= 1;
    return {
      ...request,
      maxRedirects: 0,
      maxResponseBytes: Math.min(request.maxResponseBytes, remainingBytes),
      timeoutMillis: Math.min(
        request.timeoutMillis,
        CONNECTION_LOOKUP_LIMITS.timeoutMillis,
      ),
      signal,
      beforeDispatch,
    };
  };
  const charge = (bytes: Uint8Array) => {
    remainingBytes -= bytes.byteLength;
    if (remainingBytes < 0) {
      bytes.fill(0);
      throw budgetExceeded(true);
    }
  };

  return {
    async execute(request) {
      const response = await http.execute(bounded(request));
      charge(response.body);
      return response;
    },
    executeStreaming<Body>(
      request: ProviderHttpRequest,
      consume: ProviderHttpBodyConsumer<Body>,
    ) {
      return http.executeStreaming(bounded(request), (response) =>
        consume({
          ...response,
          body: (async function* () {
            for await (const bytes of response.body) {
              charge(bytes);
              yield bytes;
            }
          })(),
        }),
      );
    },
  };
}

function budgetExceeded(possiblyDispatched: boolean) {
  return new ProviderHttpError('response_too_large', 'definite_failure', {
    possiblyDispatched,
  });
}
