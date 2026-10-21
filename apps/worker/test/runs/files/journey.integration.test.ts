import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileEnvironment } from './environment.js';
import { pagedLoopGraph } from './graphs.js';
import { fileReceiver } from './source.fixture.js';
import { measuredWorker } from './process.js';
import { reportFileQualification } from './report.js';

const enabled = process.env.F45_RELEASE_QUALIFICATION === 'true';
(enabled ? describe : describe.skip)('F45 page workflow journey', () => {
  it('runs CSV pages through both loop levels, summarizes and uploads one exact JSON file', async () => {
    const environment = await fileEnvironment();
    const receiver = await fileReceiver([]);
    let worker: Awaited<ReturnType<typeof measuredWorker>> | undefined;
    try {
      const bytes = Buffer.from(
        'currency,amount\r\n' + 'EUR,2\r\n'.repeat(2000),
      );
      const file = await environment.upload(
        environment.fixture.workspaceId,
        bytes,
        'text/csv',
      );
      const run = await environment.start(
        environment.fixture.workspaceId,
        pagedLoopGraph(receiver.origin),
        { file },
      );
      worker = await measuredWorker(environment);
      const started = Date.now();
      let maximumCheckpointBytes = 0;
      const state = await environment.fixture.waitFor(
        async () => {
          const [state] = await environment.query<{
            status: string;
            bytes: number;
            output: unknown;
          }>(
            run.workspaceId,
            `select r.status,n.output_ref as output,coalesce(octet_length(c.scheduler_state::text),0) as bytes from app.workflow_runs r left join app.run_checkpoints c on c.workflow_run_id=r.id left join app.node_runs n on n.workflow_run_id=r.id and n.node_id='finish' where r.id=$1`,
            [run.runId],
          );
          maximumCheckpointBytes = Math.max(
            maximumCheckpointBytes,
            state?.bytes ?? 0,
          );
          return state;
        },
        (state) =>
          state !== undefined &&
          ['succeeded', 'failed', 'outcome_unknown', 'timed_out'].includes(
            state.status,
          ),
        600000,
      );
      const measurement = await worker.close();
      worker = undefined;
      await reportFileQualification('F45 two-loop journey', {
        elapsedMillis: Date.now() - started,
        maximumCheckpointBytes,
        ...measurement,
        status: state?.status,
        output: state?.output,
      });
      expect(state?.status).toBe('succeeded');
      const expected = Buffer.from(
        JSON.stringify(
          Array.from({ length: 2000 }, () => ({ currency: 'EUR', amount: 2 })),
        ),
      );
      expect(receiver.received).toEqual([
        {
          kind: '/multipart',
          bytes: expected.length,
          sha256: createHash('sha256').update(expected).digest('hex'),
          parts: 1,
        },
      ]);
      expect(state?.output).toMatchObject({
        kind: 'inline',
        value: {
          summaries: [
            { groups: [{ key: 'EUR', count: 1000, sum: 2000 }] },
            { groups: [{ key: 'EUR', count: 1000, sum: 2000 }] },
          ],
        },
      });
      expect(maximumCheckpointBytes).toBeLessThanOrEqual(262144);
      expect(measurement.high.rss).toBeLessThan(805306368);
      expect(measurement.resourceDrained).toBe(false);
    } finally {
      await worker?.close();
      await receiver.close();
      await environment.close();
    }
  }, 660000);
});
