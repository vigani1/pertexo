import { subscribeSessionChanges } from '@/features/auth/model/session/sync';
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach } from 'vitest';

// Page tests render the whole app; on a busy machine the first paint can
// take longer than testing-library's 1 s default. One budget for every file.
configure({ asyncUtilTimeout: 3_000 });

// A file that doesn't load the mock server must not reach the network: any
// request fails loudly, as the shared server's 'error' mode used to make it.
// Files that load test/support/mock-server answer through MSW, which wraps this.
// Loopback stays real: a test may start its own local server (the dev proxy).
const realFetch = globalThis.fetch;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (LOOPBACK_HOSTS.has(new URL(url).hostname)) return realFetch(input, init);
  return Promise.reject(
    new Error(
      `Unmocked network request to ${url}: import test/support/mock-server or stub fetch in this test.`,
    ),
  );
};

let stopSession: (() => void) | undefined;
beforeEach(() => {
  if (typeof window !== 'undefined')
    stopSession = subscribeSessionChanges(() => undefined);
});
afterEach(() => {
  stopSession?.();
});
beforeAll(() => {
  if (typeof window !== 'undefined') {
    window.scrollTo = () => undefined;
    globalThis.ResizeObserver = class ResizeObserverMock {
      public disconnect() {
        return undefined;
      }
      public observe() {
        return undefined;
      }
      public unobserve() {
        return undefined;
      }
    };
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => null,
    });
  }
});
afterEach(() => {
  cleanup();
});
