import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { mockServer } from './support/mock-server';

// Page tests render the whole app; on a busy machine the first paint can
// take longer than testing-library's 1 s default. One budget for every file.
configure({ asyncUtilTimeout: 3_000 });

beforeAll(() => {
  mockServer.listen({ onUnhandledRequest: 'error' });
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
  mockServer.resetHandlers();
});
afterAll(() => {
  mockServer.close();
});
