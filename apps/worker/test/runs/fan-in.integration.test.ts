import type { WorkflowGraph } from '@pertexo/workflow-model';
import { forEachGraph } from '../support/coordinator/workflows/graphs/loops.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fixture,
  node,
  edge,
  publishGraph,
  accept,
  runtime,
} from './calls/calls.fixture.js';

describe.runIf(fixture.enabled)('Supported fan-in through real workers', () => {
  beforeAll(fixture.setup, 60000);
  afterAll(fixture.restoreServicesAndClose);
  it('loads 100 persisted predecessor outputs above one MiB in total and finishes', async () => {
    const sources = Array.from({ length: 100 }, (_, n) => ({
      ...node(`source-${String(n)}`, 'core.set'),
      inputMappings: {
        value: { kind: 'run_input' as const, path: '$.payload' },
      },
    }));
    const version = await publishGraph({
      settings: { maxRunDurationMs: 60000 },
      nodes: [
        node('manual', 'core.manual'),
        ...sources,
        node('sink', 'core.set'),
      ],
      edges: sources.flatMap((source) => [
        edge('manual', source.id),
        edge(source.id, 'sink'),
      ]),
    });
    const run = await accept(version, { payload: 'x'.repeat(20_000) });
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      }, 45000);
      expect(
        await fixture.workerQuery(
          'select output_ref from app.node_runs where workflow_run_id=$1 and node_id=$2',
          [run.runId, 'sink'],
        ),
      ).toEqual([{ output_ref: { kind: 'inline', value: {} } }]);
      expect(
        await fixture.workerQuery(
          'select count(*)::int count from app.node_runs where workflow_run_id=$1 and node_id like $2 and status=$3',
          [run.runId, 'source-%', 'succeeded'],
        ),
      ).toEqual([{ count: 100 }]);
    } finally {
      await workers.close();
    }
  }, 60000);
  it('finishes 100 loop children with their ordered results within a bounded time', async () => {
    const items = Array.from({ length: 100 }, (_, ordinal) => ({
      id: `item-${String(ordinal)}`,
      value: ordinal * 7,
    }));
    const base: WorkflowGraph = forEachGraph(10);
    const version = await publishGraph({
      ...base,
      nodes: base.nodes.map((entry) =>
        entry.structured?.kind === 'for_each'
          ? {
              ...entry,
              structured: { ...entry.structured, maxIterations: items.length },
              inputMappings: { items: { kind: 'literal', value: items } },
            }
          : entry,
      ),
    });
    const run = await accept(version);
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      }, 45000);
      expect(
        await fixture.workerQuery(
          'select output_ref from app.node_runs where workflow_run_id=$1 and node_id=$2',
          [run.runId, 'outer-successor'],
        ),
      ).toEqual([
        {
          output_ref: {
            kind: 'inline',
            value: {
              result: {
                items,
                iterationCount: 100,
                results: items.map((item, ordinal) => ({
                  result: { item, ordinal },
                })),
              },
            },
          },
        },
      ]);
      const times = await fixture.workerQuery<{
        count: number;
        finish_times: number;
      }>(
        `select count(*)::int count, count(distinct completed_at)::int finish_times from app.node_runs
         where workflow_run_id=$1 and node_id='body-sink' and status='succeeded'`,
        [run.runId],
      );
      expect(times[0]?.count).toBe(100);
      expect(times[0]?.finish_times).toBeGreaterThan(1);
    } finally {
      await workers.close();
    }
  }, 60000);
});
