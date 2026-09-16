import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { mockServer } from './support/mock-server';

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
