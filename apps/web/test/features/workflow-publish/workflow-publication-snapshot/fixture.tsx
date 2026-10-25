import { createApiClient } from '@/lib/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const etagA = `"draft.${'a'.repeat(43)}"`;

export const etagB = `"draft.${'b'.repeat(43)}"`;

export const graph = { nodes: [], edges: [], settings: {} };

export const report = {
  valid: true,
  currentPublication: null,
  issues: [],
  compatibility: {
    compatible: true,
    fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
    issues: [],
  },
};

export const saved = { etag: etagA, generation: 4, revision: 2 };

export function json(body: unknown, headers: HeadersInit = {}, status = 200) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set(
    'content-type',
    status === 200 ? 'application/json' : 'application/problem+json',
  );
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

export function client(fetch: typeof globalThis.fetch) {
  return createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
}

export function requestPath(input: Parameters<typeof globalThis.fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
}

export function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        {children}
      </QueryClientProvider>
    </StrictMode>
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
