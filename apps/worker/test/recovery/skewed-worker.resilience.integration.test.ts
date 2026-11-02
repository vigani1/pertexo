import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import { waitForRunsToEnd, type RunFacts } from '../support/recovery/facts.js';
import { nextStep, startFlow } from '../support/recovery/flows.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const preload = fileURLToPath(
  new URL(
    '../support/recovery/stand-ins/clock-skew-preload.mjs',
    import.meta.url,
  ),
);
const HOUR_MS = 3_600_000;
/** Far under the skew, and over what a loaded runner takes to run two steps. */
const NEAR_MS = 15 * 60_000;

type Times = Readonly<{ label: string; at: Date | null }>;

/**
 * A worker's clock used to stamp a run's history, so a worker an hour off showed a
 * run starting an hour after its first step. This one runs an hour ahead throughout.
 */
describeFaults('a worker whose clock is an hour ahead', () => {
  let stack: Stack;
  let runId: string;
  let facts: RunFacts | undefined;
  let times: readonly Times[];
  let databaseNow: number;

  beforeAll(async () => {
    stack = await startStack('skewed-worker', {
      workerEnvironment: {
        NODE_OPTIONS: `--import=${preload}`,
        CLOCK_SKEW_STAND_IN_MILLIS: String(HOUR_MS),
      },
    });
    const workspace = await stack.api.createWorkspace('recovery-skewed');
    runId = await startFlow(stack, workspace, 'skewed', [
      nextStep(stack, 'skewed-first'),
      { ...nextStep(stack, 'skewed-second'), id: 'second' },
    ]);
    facts = (await waitForRunsToEnd(stack, [runId], RECOVERY_LIMIT_MS))[runId];
    const [run] = await stack.sql<{
      started_at: Date | null;
      completed_at: Date | null;
      now: Date;
    }>(
      `select started_at,completed_at,clock_timestamp() "now"
         from app.workflow_runs where id=$1`,
      [runId],
    );
    databaseNow = run?.now.getTime() ?? 0;
    const steps = await stack.sql<{
      node_id: string;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `select node_id,started_at,completed_at from app.node_runs where workflow_run_id=$1`,
      [runId],
    );
    const events = await stack.sql<{ type: string; created_at: Date }>(
      `select type,created_at from app.run_events where workflow_run_id=$1`,
      [runId],
    );
    times = [
      { label: 'run started', at: run?.started_at ?? null },
      { label: 'run completed', at: run?.completed_at ?? null },
      ...steps.flatMap(({ node_id: nodeId, started_at, completed_at }) => [
        { label: `step ${nodeId} started`, at: started_at },
        { label: `step ${nodeId} completed`, at: completed_at },
      ]),
      ...events.map(({ type, created_at }) => ({
        label: `event ${type}`,
        at: created_at,
      })),
    ];
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('still finishes the run', () => {
    expect(facts?.status).toBe('succeeded');
  });

  it('has recorded the times this reads', () => {
    expect(times.length).toBeGreaterThanOrEqual(6);
    expect(times.filter(({ at }) => at === null)).toEqual([]);
  });

  it('leaves its own clock out of the run’s history', () => {
    const off = times.filter(
      ({ at }) => Math.abs((at?.getTime() ?? 0) - databaseNow) > NEAR_MS,
    );
    expect(off).toEqual([]);
  });
});
