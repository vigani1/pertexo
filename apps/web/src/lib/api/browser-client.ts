import { createApiClient } from './client';
import { readBrowserCsrfToken } from './csrf';

export function createBrowserApiClient() {
  return createApiClient({
    fetch: globalThis.fetch.bind(globalThis),
    readCsrfToken: readBrowserCsrfToken,
  });
}
