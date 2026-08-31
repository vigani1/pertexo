/* global process */

import {
  claimPreviewDelivery,
  completePreviewAttempt,
  markPreviewDispatched,
  parseDatabaseConfig,
  PREVIEW_STATUS,
  withTenantScopedClient,
} from '@pertexo/database/testing';
import { Pool } from 'pg';

import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.ts';
import { createDatabasePreviewAttemptRunStore } from '../src/execution/preview-attempt-runtime.ts';

const input = JSON.parse(
  process.env.PREVIEW_RECONCILIATION_CHILD_INPUT ?? '{}',
);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const pool = new Pool({ connectionString: input.workerUrl, max: 1 });

async function hangAt(injectionPoint, evidence = {}) {
  emit({ injectionPoint, pid: process.pid, ...evidence });
  await new Promise(() => undefined);
}

async function recordProviderEffect() {
  await withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    (client) =>
      client.query(
        `insert into app.preview_process_provider_effects (
         workspace_id,effect_key,invocation_count
       ) values ($1,$2,1)
       on conflict (workspace_id,effect_key)
       do update set invocation_count =
         app.preview_process_provider_effects.invocation_count + 1`,
        [input.workspaceId, input.providerEffectKey],
      ),
  );
}

async function runComposedConsumer() {
  const databaseStore = createDatabasePreviewAttemptRunStore(
    parseDatabaseConfig({ connectionString: input.workerUrl, max: 2 }),
  );
  const runStore = {
    claim: (request) => databaseStore.claim(request),
    heartbeat: (request) => databaseStore.heartbeat(request),
    markDispatched: async (request) => {
      if (input.mode === 'before-dispatch-commit') {
        await hangAt('preview.before_dispatch_marker_commit');
      }
      const result = await databaseStore.markDispatched(request);
      if (input.mode === 'after-dispatch-before-provider') {
        await hangAt('preview.dispatch_marker_committed_before_provider');
      }
      return result;
    },
    complete: async (request) => {
      if (input.mode === 'after-provider-before-outcome') {
        await hangAt('preview.provider_completed_before_outcome_commit');
      }
      const result = await databaseStore.complete(request);
      if (input.mode === 'after-outcome-before-ack') {
        await hangAt('preview.outcome_committed_before_queue_ack', {
          completionKind: result.kind,
        });
      }
      return result;
    },
  };
  const runtime = await createNodeAttemptRuntime({
    database: parseDatabaseConfig({ connectionString: input.workerUrl }),
    heartbeatIntervalMillis: 100,
    leaseDurationSeconds: input.leaseDurationSeconds,
    preview: {
      invoker: {
        invoke: async ({ runtime: executionRuntime }) => {
          if (executionRuntime === undefined)
            throw new Error('preview runtime missing');
          await executionRuntime.beforeDispatch();
          await recordProviderEffect();
          return {
            output: {
              executed: true,
              providerEffectKey: input.providerEffectKey,
            },
            status: 'succeeded',
          };
        },
      },
      runStore,
    },
    redisUrl: input.redisUrl,
    releaseCohort: 'core',
    workerId: input.workerId,
  });
  try {
    await runtime.consumer.waitUntilReady(5_000);
    emit({ injectionPoint: 'preview.consumer_ready', pid: process.pid });
    await new Promise(() => undefined);
  } finally {
    await runtime.close();
    await databaseStore.close();
  }
}

try {
  if (typeof input.mode === 'string') {
    await runComposedConsumer();
  } else {
    const claimed = await claimPreviewDelivery(pool, {
      delivery: input.delivery,
      leaseDurationSeconds: input.leaseDurationSeconds,
      previewAttemptId: input.previewAttemptId,
      previewRunId: input.previewRunId,
      workerId: input.workerId,
      workspaceId: input.workspaceId,
    });
    if (claimed.kind !== 'claimed')
      throw new Error('child claim was duplicate');
    if (input.markDispatched === true) {
      await markPreviewDispatched(pool, {
        lease: claimed.lease,
        workerId: input.workerId,
      });
    }
    if (input.complete === true) {
      await completePreviewAttempt(pool, {
        delivery: input.delivery,
        lease: claimed.lease,
        outcome: {
          safeErrorCode: 'preview.fixture_failed',
          status: PREVIEW_STATUS.failed,
        },
        workerId: input.workerId,
      });
    }
    emit({
      attemptFenceToken: claimed.lease.attemptFenceToken,
      injectionPoint:
        input.complete === true
          ? 'preview.outcome_committed_before_process_exit'
          : input.markDispatched === true
            ? 'preview.dispatch_marker_committed_before_process_exit'
            : 'preview.claim_committed_before_process_exit',
      pid: process.pid,
      providerIdempotencyKey: claimed.lease.providerIdempotencyKey ?? null,
    });
    await new Promise(() => undefined);
  }
} finally {
  await pool.end();
}
