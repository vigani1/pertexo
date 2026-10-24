import { reportFileQualification } from './report.js';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fileEnvironment } from './environment.js';
import { fileGraph, quietFileGraph } from './graphs.js';
import { fileReceiver } from './source.fixture.js';
import { measuredWorker } from './process.js';

const enabled = process.env.F45_RELEASE_QUALIFICATION === 'true';
(enabled ? describe : describe.skip)(
  'F45 maximum multipart concurrency',
  () => {
    it('holds 32 maximum multipart requests on disk while short workflows remain schedulable', async () => {
      const environment = await fileEnvironment();
      const receiver = await fileReceiver([]);
      let worker: Awaited<ReturnType<typeof measuredWorker>> | undefined;
      try {
        while (environment.workspaces.length < 9)
          await environment.addWorkspace();
        const bytes = Buffer.alloc(10485760 - 32768, 97);
        const runs: { workspaceId: string; runId: string }[] = [];
        for (const workspaceId of environment.workspaces.slice(0, 8)) {
          const file = await environment.upload(
            workspaceId,
            bytes,
            'application/octet-stream',
          );
          for (let index = 0; index < 4; index++)
            runs.push(
              await environment.start(
                workspaceId,
                fileGraph('multipart', receiver.origin),
                { file },
              ),
            );
        }
        receiver.hold();
        worker = await measuredWorker(environment);
        await expect
          .poll(() => receiver.pending, { timeout: 25_000, interval: 25 })
          .toBe(32);
        expect(receiver.pending).toBe(32);
        const quietStarted = Date.now();
        for (const workspaceId of [
          environment.workspaces[0],
          environment.workspaces[8],
        ]) {
          if (workspaceId === undefined)
            throw new Error('Missing witness workspace');
          runs.push(await environment.start(workspaceId, quietFileGraph()));
        }
        receiver.release();
        let quietMillis = 0;
        await environment.fixture.waitFor(
          async () => {
            const statuses = [];
            for (const run of runs) {
              const [state] = await environment.query<{ status: string }>(
                run.workspaceId,
                'select status from app.workflow_runs where id=$1',
                [run.runId],
              );
              statuses.push(state?.status);
            }
            if (
              quietMillis === 0 &&
              statuses.slice(-2).every((status) => status === 'succeeded')
            )
              quietMillis = Date.now() - quietStarted;
            return statuses;
          },
          (statuses) => statuses.every((status) => status === 'succeeded'),
          60000,
        );
        const measurement = await worker.close();
        worker = undefined;
        await reportFileQualification('F45 32 maximum multipart requests', {
          ...measurement,
          quietMillis,
        });
        expect(measurement.maximumActive).toBe(32);
        expect(measurement.high.rss).toBeLessThan(805306368);
        expect(measurement.resourceDrained).toBe(false);
        expect(measurement.high.scratchBytes).toBeGreaterThan(300 * 1048576);
        expect(measurement.high.scratchBytes).toBeLessThanOrEqual(
          32 * 20 * 1048576,
        );
        expect(quietMillis).toBeLessThan(30000);
        expect(receiver.received).toHaveLength(32);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        expect(
          receiver.received.every(
            (value) =>
              value.parts === 64 &&
              value.bytes === bytes.length &&
              value.sha256 === sha256,
          ),
        ).toBe(true);
        expect(await readdir(environment.scratch.directory)).toEqual([]);
      } finally {
        receiver.release();
        await worker?.close();
        await receiver.close();
        await environment.close();
      }
    }, 300000);
  },
);
