import { request as httpRequest } from 'node:http';

import { expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import { ApiDrainState } from '../../../src/platform/health/drain-state.js';

import type { ApiWorkflowRuntime } from '../../../src/platform/workflow/runtime.module.js';

import { createStubApiWorkflowRuntime } from '../../support/api-platform.fixture.js';
import {
  config,
  dependencies,
  identityRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerClosesRealOpenSSERequestWithout(): void {
  it('closes a real open SSE request without client cooperation', async () => {
    const selectedIdentityRuntime = identityRuntime(
      vi.fn().mockResolvedValue(undefined),
      true,
    );
    const baseRuntime = createStubApiWorkflowRuntime(
      selectedIdentityRuntime.dependencies.authorization,
    );
    let producerClosed = false;
    const selectedWorkflowRuntime: ApiWorkflowRuntime = {
      ...baseRuntime,
      runDependencies: {
        ...baseRuntime.runDependencies,
        persistence: {
          ...baseRuntime.runDependencies.persistence,
          get: () =>
            Promise.resolve({
              run: {
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                status: 'running' as const,
                triggerType: 'manual' as const,
                createdAt: new Date(),
                updatedAt: new Date(),
                startedAt: new Date(),
                completedAt: null,
                deadlineAt: null,
                cancelRequestedAt: null,
              },
              nodes: [],
            }),
        },
        streamer: {
          stream: ({ signal }) => ({
            async *[Symbol.asyncIterator]() {
              try {
                yield {
                  id: 1,
                  event: 'run.started',
                  data: JSON.stringify({
                    sequence: 1,
                    type: 'run.started',
                    createdAt: new Date().toISOString(),
                    payload: {},
                  }),
                };
                await new Promise<void>((resolve) => {
                  if (signal.aborted) resolve();
                  else
                    signal.addEventListener(
                      'abort',
                      () => {
                        resolve();
                      },
                      { once: true },
                    );
                });
              } finally {
                producerClosed = true;
              }
            },
          }),
        },
      },
    };
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      workflowRuntime: selectedWorkflowRuntime,
    });
    await applicationFixture.application.listen(0, '127.0.0.1');
    const address = applicationFixture.application
      .getHttpServer()
      .address() as {
      port: number;
    };
    const responseStarted = Promise.withResolvers<undefined>();
    const client = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/events',
      headers: { cookie: `pertexo_session=${'x'.repeat(40)}` },
    });
    const startTimer = setTimeout(() => {
      responseStarted.reject(new Error('SSE response did not start'));
    }, 1_000);
    const rejectStart = (error: Error) => {
      responseStarted.reject(error);
    };
    client.once('error', rejectStart);
    client.on('response', (response) => {
      response.once('data', () => {
        responseStarted.resolve(undefined);
      });
      response.once('error', rejectStart);
      response.once('end', () => {
        responseStarted.reject(new Error('SSE response ended before a frame'));
      });
      response.resume();
    });
    client.end();
    try {
      await responseStarted.promise.finally(() => {
        clearTimeout(startTimer);
      });
      const drainState = applicationFixture.application.get(ApiDrainState);
      let closeTimer: NodeJS.Timeout | undefined;
      const closeDeadline = new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => {
          reject(new Error('SSE application close timed out'));
        }, 1_000);
      });

      await Promise.race([
        applicationFixture.application.close(),
        closeDeadline,
      ]).finally(() => {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      });
      applicationFixture.application = undefined;

      expect(producerClosed).toBe(true);
      expect(drainState.activeStreamCount()).toBe(0);
      expect(selectedWorkflowRuntime.close).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(startTimer);
      client.destroy();
    }
  });
}
