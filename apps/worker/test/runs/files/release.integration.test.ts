import { reportFileQualification } from './report.js';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { fileEnvironment } from './environment.js';
import { fileGraph, quietFileGraph, type FileWorkload } from './graphs.js';
import { dataset, fileReceiver } from './source.fixture.js';
import { measuredWorker } from './process.js';

const enabled = process.env.F45_RELEASE_QUALIFICATION === 'true';
(enabled ? describe : describe.skip)(
  'F45 whole-worker release qualification',
  () => {
    it('keeps default-concurrency mixed file workflows bounded and short work responsive', async () => {
      const environment = await fileEnvironment();
      try {
        while (environment.workspaces.length < 9)
          await environment.addWorkspace();
        for (const size of [1048576, 10485760]) {
          const input = dataset(size === 1048576 ? 10000 : 100000, size);
          const receiver = await fileReceiver(input.rows);
          const runs: {
            workspaceId: string;
            runId: string;
            kind: FileWorkload | 'quiet';
          }[] = [];
          let worker: Awaited<ReturnType<typeof measuredWorker>> | undefined;
          try {
            const uploads = new Map<
              string,
              {
                json: Awaited<ReturnType<typeof environment.upload>>;
                csv: Awaited<ReturnType<typeof environment.upload>>;
                raw: Awaited<ReturnType<typeof environment.upload>>;
                multipart: Awaited<ReturnType<typeof environment.upload>>;
              }
            >();
            for (const workspaceId of environment.workspaces.slice(0, 8)) {
              const raw = Buffer.alloc(size, 97),
                multipart = raw.subarray(0, size - 32768);
              uploads.set(workspaceId, {
                json: await environment.upload(
                  workspaceId,
                  input.json,
                  'application/json',
                ),
                csv: await environment.upload(
                  workspaceId,
                  input.csv,
                  'text/csv',
                ),
                raw: await environment.upload(
                  workspaceId,
                  raw,
                  'application/octet-stream',
                ),
                multipart: await environment.upload(
                  workspaceId,
                  multipart,
                  'application/octet-stream',
                ),
              });
            }
            const kinds = ['raw', 'multipart', 'csv', 'json', 'http'] as const;
            for (let index = 0; index < 32; index++) {
              const workspaceId =
                environment.workspaces[Math.floor(index / 4)] ?? '';
              const kind = kinds[index % kinds.length] ?? 'raw';
              const upload = uploads.get(workspaceId);
              if (upload === undefined)
                throw new Error('Missing source upload');
              const file = kind === 'http' ? undefined : upload[kind];
              runs.push({
                ...(await environment.start(
                  workspaceId,
                  fileGraph(kind, receiver.origin),
                  file === undefined ? {} : { file },
                )),
                kind,
              });
            }
            const [walBefore] = await environment.fixture.ownerPool
              .query<{
                lsn: string;
                inserted: string;
                updated: string;
                deleted: string;
              }>(
                `select pg_current_wal_lsn()::text as lsn,tup_inserted::text as inserted,tup_updated::text as updated,tup_deleted::text as deleted from pg_stat_database where datname=current_database()`,
              )
              .then((result) => result.rows);
            const started = Date.now();
            worker = await measuredWorker(environment);
            await setTimeout(500);
            const quietStarted = Date.now();
            for (const workspaceId of [
              environment.workspaces[0],
              environment.workspaces[8],
            ]) {
              if (workspaceId === undefined)
                throw new Error('Missing quiet workspace');
              runs.push({
                ...(await environment.start(workspaceId, quietFileGraph())),
                kind: 'quiet',
              });
            }
            let quietMillis = 0,
              maximumCheckpointBytes = 0,
              maximumWorkspaceSlots = 0;
            const deadline = Date.now() + 300000;
            const outcomes = new Map<string, string>();
            do {
              for (const workspaceId of environment.workspaces) {
                const states = await environment.query<{
                  id: string;
                  status: string;
                  bytes: number;
                }>(
                  workspaceId,
                  `select r.id,r.status,coalesce(octet_length(c.scheduler_state::text),0) as bytes from app.workflow_runs r left join app.run_checkpoints c on c.workflow_run_id=r.id where r.workspace_id=$1`,
                  [workspaceId],
                );
                let occupied = 0;
                for (const state of states) {
                  outcomes.set(state.id, state.status);
                  maximumCheckpointBytes = Math.max(
                    maximumCheckpointBytes,
                    state.bytes,
                  );
                  if (['running', 'waiting'].includes(state.status)) occupied++;
                }
                maximumWorkspaceSlots = Math.max(
                  maximumWorkspaceSlots,
                  occupied,
                );
              }
              if (
                quietMillis === 0 &&
                runs
                  .filter((run) => run.kind === 'quiet')
                  .every((run) => outcomes.get(run.runId) === 'succeeded')
              )
                quietMillis = Date.now() - quietStarted;
              if (
                runs.every((run) =>
                  [
                    'succeeded',
                    'failed',
                    'timed_out',
                    'outcome_unknown',
                    'canceled',
                  ].includes(outcomes.get(run.runId) ?? ''),
                )
              )
                break;
              await setTimeout(100);
            } while (Date.now() < deadline);
            const measurement = await worker.close();
            worker = undefined;
            const [writes] = await environment.fixture.ownerPool
              .query<{
                wal_bytes: string;
                inserted: string;
                updated: string;
                deleted: string;
              }>(
                `select pg_wal_lsn_diff(pg_current_wal_lsn(),$1)::text as wal_bytes,tup_inserted::text as inserted,tup_updated::text as updated,tup_deleted::text as deleted from pg_stat_database where datname=current_database()`,
                [walBefore?.lsn],
              )
              .then((result) => result.rows);
            await reportFileQualification('F45 whole-worker', {
              size,
              count: input.rows.length,
              elapsedMillis: Date.now() - started,
              quietMillis,
              maximumCheckpointBytes,
              maximumWorkspaceSlots,
              ...measurement,
              writes: {
                walBytes: Number(writes?.wal_bytes),
                inserted:
                  Number(writes?.inserted) - Number(walBefore?.inserted),
                updated: Number(writes?.updated) - Number(walBefore?.updated),
                deleted: Number(writes?.deleted) - Number(walBefore?.deleted),
              },
              outcomes: runs.reduce<Record<string, number>>((counts, run) => {
                const status = outcomes.get(run.runId) ?? 'missing';
                counts[status] = (counts[status] ?? 0) + 1;
                return counts;
              }, {}),
            });
            expect(runs.map((run) => outcomes.get(run.runId))).toEqual(
              runs.map(() => 'succeeded'),
            );
            expect(measurement.high.rss).toBeLessThan(805306368);
            expect(measurement.resourceDrained).toBe(false);
            expect(measurement.high.scratchBytes).toBeLessThanOrEqual(
              1073741824,
            );
            expect(measurement.maximumActive).toBeLessThanOrEqual(32);
            expect(measurement.failed).toBe(0);
            expect(maximumCheckpointBytes).toBeLessThanOrEqual(262144);
            expect(maximumWorkspaceSlots).toBeLessThanOrEqual(5);
            expect(quietMillis).toBeGreaterThan(0);
            expect(quietMillis).toBeLessThan(30000);
            for (const run of runs.filter((run) =>
              ['csv', 'json', 'http'].includes(run.kind),
            )) {
              const [created] = await environment.query<{ output: unknown }>(
                run.workspaceId,
                `select output_ref as output from app.node_runs where workflow_run_id=$1 and node_id='create'`,
                [run.runId],
              );
              expect(created?.output).toMatchObject({
                kind: 'inline',
                value: {
                  file: {
                    byteLength: input.expected.bytes,
                    sha256: input.expected.sha256,
                  },
                },
              });
            }
            const rawHash = createHash('sha256')
              .update(Buffer.alloc(size, 97))
              .digest('hex');
            const multipartHash = createHash('sha256')
              .update(Buffer.alloc(size - 32768, 97))
              .digest('hex');
            expect(
              receiver.received.filter((value) => value.kind === '/raw'),
            ).toHaveLength(runs.filter((run) => run.kind === 'raw').length);
            expect(
              receiver.received
                .filter((value) => value.kind === '/raw')
                .every(
                  (value) => value.bytes === size && value.sha256 === rawHash,
                ),
            ).toBe(true);
            expect(
              receiver.received
                .filter((value) => value.kind === '/multipart')
                .every(
                  (value) =>
                    value.parts === 64 &&
                    value.bytes === size - 32768 &&
                    value.sha256 === multipartHash,
                ),
            ).toBe(true);
            expect(await readdir(environment.scratch.directory)).toEqual([]);
          } finally {
            await worker?.close();
            await receiver.close();
          }
        }
      } finally {
        await environment.close();
      }
    }, 900000);
  },
);
