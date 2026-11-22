import { CONNECTION_LOOKUP_LIMITS } from '@pertexo/contracts';
import type {
  ProviderHttpBodyConsumer,
  ProviderHttpClient,
  ProviderHttpRequest,
} from '@pertexo/integrations/server';

type LookupHttp = Pick<ProviderHttpClient, 'executeStreaming'>;

export function boundedLookupHttp(
  http: LookupHttp,
  signal: AbortSignal,
  beforeDispatch: () => Promise<void>,
): LookupHttp {
  let remainingBytes: number = CONNECTION_LOOKUP_LIMITS.bytes;
  let remainingExchanges: number = CONNECTION_LOOKUP_LIMITS.exchanges;
  return {
    async executeStreaming<Body>(
      request: ProviderHttpRequest,
      consume: ProviderHttpBodyConsumer<Body>,
    ) {
      signal.throwIfAborted();
      if (remainingExchanges <= 0 || remainingBytes <= 0)
        throw new RangeError('Connection lookup exceeded its request budget');
      remainingExchanges -= 1;
      return http.executeStreaming(
        {
          ...request,
          maxRedirects: 0,
          maxResponseBytes: Math.min(request.maxResponseBytes, remainingBytes),
          timeoutMillis: Math.min(
            request.timeoutMillis,
            CONNECTION_LOOKUP_LIMITS.timeoutMillis,
          ),
          signal,
          beforeDispatch,
        },
        (response) =>
          consume({
            ...response,
            body: (async function* () {
              for await (const bytes of response.body) {
                remainingBytes -= bytes.byteLength;
                if (remainingBytes < 0)
                  throw new RangeError(
                    'Connection lookup exceeded its response budget',
                  );
                yield bytes;
              }
            })(),
          }),
      );
    },
  };
}
