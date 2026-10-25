import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, StrictMode, type ReactNode } from 'react';
import { vi } from 'vitest';
export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const etagA = `"draft.${'a'.repeat(43)}"`;

export const etagB = `"draft.${'b'.repeat(43)}"`;

export const emptyGraph = { nodes: [], edges: [], settings: {} };

export function savedState(etag: string, revision: number, generation: number) {
  return {
    etag,
    revision,
    generation,
    saveStatus: 'clean',
  } as const;
}

export function compatibility() {
  return {
    compatible: true,
    fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
    issues: [],
  };
}

export function apiClientFor(
  request: (input: ApiJsonRequest<unknown>) => Promise<unknown>,
): ApiClient {
  return {
    request,
    stream: vi.fn(),
  } as unknown as ApiClient;
}

export function acceptedRun() {
  return {
    run: {
      id: runId,
      workspaceId,
      workflowId,
      workflowVersionId: versionId,
      status: 'queued',
      triggerType: 'manual',
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
      startedAt: null,
      completedAt: null,
      deadlineAt: null,
      cancelRequestedAt: null,
    },
    replayed: false,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function StrictModeWrapper({
  children,
}: Readonly<{ children: ReactNode }>) {
  return createElement(StrictMode, undefined, children);
}

export function QueryWrapper({ children }: Readonly<{ children: ReactNode }>) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    children,
  );
}
