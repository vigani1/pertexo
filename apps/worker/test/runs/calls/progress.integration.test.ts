import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  accept,
  childGraph,
  fixture,
  parentGraph,
  publishGraph,
  runtime,
} from './calls.fixture.js';
import { describeIntegration } from './calls-execution.fixture.js';

describeIntegration('Call transport progress during observation', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);

  it('finishes a Call while its observer awaits the persisted result', async () => {
    const child = await publishGraph(childGraph());
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    const result = fixture.waitFor(
      () =>
        fixture.workerQuery<{ status: string; output_ref: unknown }>(
          'select status,output_ref from app.workflow_runs where id=$1',
          [accepted.runId],
        ),
      (rows) => rows[0]?.status === 'succeeded',
    );
    try {
      await workers.until(async () => {
        const rows = await result;
        expect(rows).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'Ada!' },
          },
        ]);
      });
    } finally {
      await result.catch(() => undefined);
      await workers.close();
    }
  });
});
