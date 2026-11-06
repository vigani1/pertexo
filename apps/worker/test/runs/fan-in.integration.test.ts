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
});
