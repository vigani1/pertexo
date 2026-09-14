import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  type SecureHttpTransportResponse,
} from '../src/server.js';

const hostile = new Proxy(
  {},
  {
    getPrototypeOf: () => {
      throw new Error('hostile-prototype-trap');
    },
  },
);

const client = new SecureHttpClient(
  {
    resolve: () =>
      Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]),
  },
  {
    dispatch: () => {
      // Deliberately model an untrusted transport rejection.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject<SecureHttpTransportResponse>(hostile);
    },
  },
);

try {
  await client.execute({
    url: 'https://api.example.test/resource',
    method: 'GET',
    timeoutMillis: 1_000,
    maxRedirects: 0,
    maxResponseBytes: 1_024,
    beforeDispatch: () => Promise.resolve(),
  });
  process.exitCode = 2;
} catch (error: unknown) {
  if (
    typeof error !== 'object' ||
    error === null ||
    (error as { readonly code?: unknown }).code !==
      SECURE_HTTP_ERROR_CODE.networkFailed
  )
    process.exitCode = 3;
}

await new Promise<void>((resolve) => {
  setImmediate(resolve);
});
