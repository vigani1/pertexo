import { randomUUID } from 'node:crypto';
import { createPreviewAttemptRunStore } from '@pertexo/core/previews';

import { parseDatabaseConfig } from '@pertexo/database/testing';
import { parseStoredExecutionValue } from '@pertexo/core/runs';
import type { AcceptPreviewRunInput } from '@pertexo/core/testing';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { createQueueProducer } from '@pertexo/queue';
import { describe, expect, it } from 'vitest';

import { createNodeAttemptRuntime } from '../../../src/attempts/delivery/runtime.js';
import { createPlatformPreviewNodeInvoker } from '../../../src/previews/runtime.js';
import {
  acceptDelivery,
  databaseUrl,
  redisUrl,
  validTraceparent,
  waitFor,
  withPublishedPreviewDelivery,
  withTenantScopedWorker,
  workerTransportIntegrationEnabled,
  workerUrl,
} from '../../support/previews/consumer.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

function nextStep(
  inputMappings: Record<string, unknown>,
): AcceptPreviewRunInput['executableNode'] {
  return {
    config: {},
    configVersion: 1,
    definition: { key: 'core.set', version: 1 },
    id: 'node-2',
    inputMappings,
    connectionRefs: {},
  };
}

describeIntegration('step test fed by a prior test', () => {
  it('maps the tested step’s output and names a mapping it cannot supply', async () => {
    const runtime = await createNodeAttemptRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
      }),
      heartbeatIntervalMillis: 200,
      leaseDurationSeconds: 10,
      preview: {
        invoker: createPlatformPreviewNodeInvoker({
          registry: createPlatformNodeRegistry(),
        }),
        runStore: createPreviewAttemptRunStore(
          parseDatabaseConfig({ connectionString: databaseUrl(workerUrl) }),
        ),
      },
      redisUrl,
      workerId: `preview-prior-${randomUUID().slice(0, 8)}`,
    });
    try {
      const first = await acceptDelivery(validTraceparent);
      await withPublishedPreviewDelivery(runtime, first, () =>
        Promise.resolve(),
      );
      const fromPrior = {
        kind: 'prior_preview' as const,
        previewRunId: first.accepted.previewRunId,
      };

      const mapped = await acceptDelivery(validTraceparent, {
        nodeId: 'node-2',
        executableNode: nextStep({
          greeting: { kind: 'node_output', nodeId: 'node-1', path: '$.hello' },
          whole: { kind: 'node_output', nodeId: 'node-1', path: '$' },
        }),
        input: fromPrior,
      });
      await withPublishedPreviewDelivery(runtime, mapped, ({ state }) => {
        expect(parseStoredExecutionValue(state?.output_ref)).toEqual({
          kind: 'inline',
          value: { greeting: 'transport', whole: { hello: 'transport' } },
        });
        return Promise.resolve();
      });

      const unlinked = await acceptDelivery(validTraceparent, {
        nodeId: 'node-2',
        executableNode: nextStep({
          other: { kind: 'node_output', nodeId: 'node-0', path: '$' },
        }),
        input: fromPrior,
      });
      await expect(
        failure(runtime, unlinked.accepted.previewRunId, unlinked.job),
      ).resolves.toEqual({
        safe_error_code: 'preview.input_invalid',
        error_summary:
          'Input other uses another step’s output. Test that step first, then test this one with “Use the output from testing” switched on.',
      });
    } finally {
      await runtime.close();
    }
  });
});

async function failure(
  runtime: Awaited<ReturnType<typeof createNodeAttemptRuntime>>,
  previewRunId: string,
  job: Awaited<ReturnType<typeof acceptDelivery>>['job'],
) {
  const producer = createQueueProducer({ redisUrl });
  try {
    await Promise.all([
      runtime.consumer.waitUntilReady(5_000),
      producer.waitUntilReady(5_000),
    ]);
    await producer.publish({ data: job.data, name: job.name });
    return await waitFor(
      () =>
        withTenantScopedWorker((client) =>
          client.query<{
            error_summary: string | null;
            safe_error_code: string | null;
            status: string;
          }>(
            `select run.status, run.safe_error_code, attempt.error_summary
               from app.preview_runs run
               join app.preview_attempts attempt
                 on attempt.workspace_id = run.workspace_id
                and attempt.preview_run_id = run.id
              where run.id = $1`,
            [previewRunId],
          ),
        ).then((result) => result.rows[0]),
      (row) => row?.status === 'failed',
    ).then((row) => ({
      safe_error_code: row?.safe_error_code,
      error_summary: row?.error_summary,
    }));
  } finally {
    await producer.close();
  }
}
