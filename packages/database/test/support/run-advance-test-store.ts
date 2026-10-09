import { Pool } from 'pg';
import { parseCheckpoint } from '@pertexo/workflow-engine';

import type { DatabaseConfig } from '../../src/config.js';
import type { DatabaseRuntime } from '../../src/platform/database-runtime.js';
import type { CoordinatorAdvanceDelivery } from '../../src/runs/advance/contract.js';
import type { RunTransitionPlan } from '../../src/runs/advance/plan.js';
import { loadRunForAdvance } from '../../src/runs/advance/state.js';
import {
  createRunAdvanceStore,
  type RunAdvanceStoreOptions,
} from '../../src/runs/advance/store.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from '../baseline-compatibility-fixture.js';

type AdvanceInput = Readonly<{
  delivery: CoordinatorAdvanceDelivery;
  workspaceId: string;
  runId: string;
  traceparent?: string;
  signal: AbortSignal;
}>;

export type TestCommitInput = AdvanceInput &
  Readonly<{ workflowVersionId?: string; plan: unknown }>;

/** Hand-written plans may omit the admission kind the engine always sets. */
function withAdmissionKinds(plan: RunTransitionPlan): RunTransitionPlan {
  return {
    ...plan,
    attempts: plan.attempts.map((attempt) => ({
      ...attempt,
      admissionKind: (attempt.admissionKind as string | undefined)
        ? attempt.admissionKind
        : 'execute',
    })),
  };
}

/**
 * Storage tests drive the advance transaction with a scripted decision: they
 * save a hand-written transition, or acknowledge without one. Loads use the
 * same locked read the transaction uses, then roll back.
 */
export function createTestRunStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  options: Partial<RunAdvanceStoreOptions> = {},
) {
  const store = createRunAdvanceStore(config, runtime, {
    compatibilityReleases: BASELINE_COMPATIBILITY_EXPECTATION,
    ...options,
  });
  const readPool = new Pool({
    connectionString: config.connectionString,
    max: 1,
  });
  return Object.freeze({
    loadAdvanceState: async (
      input: Readonly<{
        workspaceId: string;
        runId: string;
        signal?: AbortSignal;
      }>,
    ) => {
      const client = await readPool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          input.workspaceId,
        ]);
        const loaded = await loadRunForAdvance(client, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          servingRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        });
        return loaded.kind === 'loaded'
          ? Object.freeze({ kind: 'ready' as const, state: loaded.state })
          : loaded;
      } finally {
        await client.query('rollback');
        client.release();
      }
    },
    acknowledgeAdvanceDelivery: (input: AdvanceInput) =>
      store.advance(input, () =>
        Promise.resolve({ kind: 'no_change' as const }),
      ),
    commitAdvancePlan: (input: TestCommitInput) =>
      store.advance(input, (state) =>
        Promise.resolve({
          kind: 'transition' as const,
          previous: parseCheckpoint(state.checkpoint),
          plan: withAdmissionKinds(input.plan as RunTransitionPlan),
        }),
      ),
    close: async () => {
      await Promise.all([store.close(), readPool.end()]);
    },
  });
}

export type TestRunStore = ReturnType<typeof createTestRunStore>;
