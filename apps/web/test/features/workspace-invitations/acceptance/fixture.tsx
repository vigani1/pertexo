import { createApiClient } from '@/lib/api/client';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const intentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const csrfToken = 'invitation-csrf-token-that-is-long-enough';

export const otherIntentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export function componentApiClient(fetchImplementation = globalThis.fetch) {
  return createApiClient({
    fetch: (input, init) =>
      fetchImplementation(
        typeof input === 'string'
          ? new URL(input, 'http://pertexo.test')
          : input,
        init,
      ),
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
}
