import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { WorkflowRunsController } from '../../../../src/workflow-runs/http/controllers.js';
import { ApiDrainState } from '../../../../src/platform/health/drain-state.js';
import type { SseVisibilityMetrics } from '../../../../src/platform/observability/sse-visibility-metrics.js';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const guardActorId = '99999999-9999-4999-8999-999999999999';

export const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const workflowVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export function request(headers: Record<string, string> = {}) {
  const closeListeners = new Set<() => void>();
  return {
    requestId: 'request-42',
    traceId: 'trace-42',
    headers,
    identitySession: {
      userId: actorId,
      sessionId,
      expiresAt: new Date('2026-08-21T20:00:00.000Z'),
      clientMetadata: {},
    },
    reauthorizeIdentitySession: () =>
      Promise.resolve({
        userId: actorId,
        sessionId,
        expiresAt: new Date('2026-08-21T20:00:00.000Z'),
        clientMetadata: {},
      }),
    raw: {
      once: (_event: 'close', listener: () => void) => {
        closeListeners.add(listener);
      },
      off: (_event: 'close', listener: () => void) => {
        closeListeners.delete(listener);
      },
    },
  } as const;
}

export function sseReply() {
  const raw = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headersSent: boolean;
    destroyed: boolean;
    chunks: string[];
    setHeader: (name: string, value: string) => void;
    flushHeaders: () => void;
    write: (chunk: string) => boolean;
    end: () => void;
    destroy: () => void;
  };
  raw.statusCode = 0;
  raw.headersSent = false;
  raw.destroyed = false;
  raw.chunks = [];
  raw.setHeader = vi.fn();
  raw.flushHeaders = () => {
    raw.headersSent = true;
  };
  raw.write = (chunk) => {
    raw.chunks.push(chunk);
    return true;
  };
  raw.end = vi.fn();
  raw.destroy = () => {
    raw.destroyed = true;
  };
  return { raw, hijack: vi.fn() };
}

export function controller() {
  const start = {
    execute: vi.fn().mockResolvedValue({ run: {}, replayed: false }),
  };
  const replay = {
    execute: vi.fn().mockResolvedValue({ run: {}, replayed: false }),
  };
  const get = { execute: vi.fn().mockResolvedValue({ run: {}, nodes: [] }) };
  const list = {
    execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  const statistics = {
    execute: vi.fn().mockResolvedValue({ current: {} }),
  };
  const cancel = {
    execute: vi.fn().mockResolvedValue({ run: {}, alreadyRequested: false }),
  };
  const stream = {
    execute: vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield {
          id: 2,
          event: 'run.started',
          data: JSON.stringify({
            sequence: 2,
            type: 'run.started',
            createdAt: '2026-08-21T12:00:00.000Z',
            payload: {},
          }),
        };
      },
    }),
  };
  return {
    instance: new WorkflowRunsController(
      start as never,
      replay as never,
      get as never,
      list as never,
      statistics as never,
      stream as never,
      cancel as never,
    ),
    start,
    replay,
    get,
    list,
    statistics,
    stream,
    cancel,
  };
}

export function streamController(
  stream: unknown,
  visibilityMetrics: SseVisibilityMetrics,
  drainState = new ApiDrainState(),
) {
  return new WorkflowRunsController(
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    stream as never,
    { execute: vi.fn() } as never,
    visibilityMetrics,
    drainState,
  );
}
