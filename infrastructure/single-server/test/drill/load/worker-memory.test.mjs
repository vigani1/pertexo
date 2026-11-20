import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkspace } from '../support/product.mjs';
import { createReport } from '../support/simulation-report.mjs';
import { destroyServer } from '../support/server.mjs';
import {
  checkRuns,
  memoryTrend,
  restartsAndKills,
  startLatency,
  startSampler,
  summarizeRequests,
  summarizeSamples,
  waitForDrain,
} from './observer.mjs';
import { containerLimitMib, nodeProcessMemory } from './process-memory.mjs';
import { deployMinimumServer, targetCounts } from './stack.mjs';
import {
  createLedger,
  pace,
  publishFetchAndTransformHooks,
  publishTeamWorkflows,
  sendDelivery,
  sleep,
  stopAllTraffic,
} from './traffic.mjs';

// The worker at its busiest everyday work on the minimum-size server: webhooks
// that fetch a 40 KiB page from an outside API and transform it in JavaScript
// or Python, calls to a slow, flaky API with retries, and plain Code, in three
// workspaces at once. It watches what the API showed under a flood: memory
// growing outside the V8 heap (glibc's per-thread malloc arenas). Rerun on
// Linux with Docker and sudo:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   LOAD_MINUTES=45 node --test infrastructure/single-server/test/drill/load/worker-memory.test.mjs

const MINUTES = Number(process.env.LOAD_MINUTES ?? 45);
const WORKSPACES = 3;
// Per workspace; together 3 runs a second, 2 of them with Code: about what the
// minimum server's worker carries (2.7 a second measured), so it stays at its
// busiest with a short queue.
const EVERY = {
  fetchJavascript: 3_000,
  fetchPython: 6_000,
  flakyHttp: 3_000,
  code: 6_000,
};
// The Node services whose own memory figures are read.
const NODE_SERVICES = ['worker', 'code-runner'];
const DRAIN_MILLIS = 20 * 60_000;
const WARM_UP_MILLIS = Math.min(10, MINUTES / 6) * 60_000;
// The worker drains itself when its RSS passes its cap (WORKER_MAX_RSS_BYTES,
// 512 MiB). Past warm-up, at its busiest, it peaked at 441 MiB without
// MALLOC_ARENA_MAX=2 and at 407 MiB with it (S10, 2026-11-20).
const PEAK_SHARE_OF_CAP = 0.82;
// 30 MiB an hour fills the worker's cap in about 17 hours.
const LEAK_MIB_PER_HOUR = 30;
// Reading a process's figures can miss now and then (a busy event loop).
const PROCESS_READ_SHARE = 0.9;
// The flaky API fails 15% of calls and a step tries five times, so about one
// call in 13,000 fails for good: 0.3 an hour at this rate. That is the outside
// API's failure reported honestly, not the worker's.
const EXHAUSTED_FLAKY_CALLS = 3;
const EXHAUSTED_FLAKY_CALL =
  'flakyHttp: failed: call failed execution.provider';

const record = createReport();

describe(`the worker under ${MINUTES} minutes of Code- and HTTP-heavy load`, () => {
  let server;
  let setup;
  let started;
  let ledger;
  let sampler;

  before(async () => {
    setup = await deployMinimumServer();
    server = setup.server;
  });
  after(async () => {
    await stopAllTraffic();
    await sampler?.stop();
    if (process.env.DRILL_KEEP !== 'true') await destroyServer();
  });

  it(`carries the load for ${MINUTES} minutes and drains`, async () => {
    const { client } = setup;
    const workspaces = [];
    for (let index = 0; index < WORKSPACES; index++) {
      const workspaceId = await createWorkspace(client);
      const team = await publishTeamWorkflows(client, workspaceId);
      const fetches = await publishFetchAndTransformHooks(client, workspaceId);
      workspaces.push({
        workspaceId,
        hooks: {
          fetchJavascript: fetches.javascript,
          fetchPython: fetches.python,
          flakyHttp: team.httpHook,
          code: team.codeHook,
        },
      });
    }
    const idle = {};
    for (const service of NODE_SERVICES)
      idle[service] = await nodeProcessMemory(server, service);
    record('idle', idle);
    ledger = createLedger();
    started = Date.now();
    sampler = startSampler(server, { processes: NODE_SERVICES });
    const loops = workspaces.flatMap(({ workspaceId, hooks }) =>
      Object.entries(EVERY).map(([kind, millis]) =>
        pace(millis, () =>
          sendDelivery(ledger, client, kind, workspaceId, hooks[kind]),
        ),
      ),
    );
    const progress = setInterval(() => {
      const last = sampler.samples.findLast((sample) => sample.process);
      console.log(
        `${Math.round((Date.now() - started) / 60_000)} min: ${JSON.stringify(last?.process)} queued ${last?.database?.runs?.queued ?? 0}`,
      );
    }, 5 * 60_000);
    await sleep(MINUTES * 60_000);
    clearInterval(progress);
    await Promise.all(loops.map((loop) => loop.stop()));
    const trafficEnded = Date.now();
    const unfinished = await waitForDrain(server, DRAIN_MILLIS);
    await sampler.stop();
    record('worker load', {
      minutes: MINUTES,
      workspaces: WORKSPACES,
      everyMillisPerWorkspace: EVERY,
      drainMillis: Date.now() - trafficEnded,
      unfinishedAfterDrain: unfinished,
    });
    assert.equal(unfinished, 0, 'every run ends once the traffic stops');
  });

  it('loses, duplicates, strands and fails no run', async () => {
    assert.ok(ledger, 'the load ran');
    const runs = await checkRuns(server, ledger);
    record('runs', {
      ...runs,
      target: await targetCounts(server),
      requests: summarizeRequests(ledger.requests, started).byKind,
      latency: (await startLatency(server, started)).overall,
    });
    assert.deepEqual(runs.lost, []);
    assert.deepEqual(runs.duplicated, []);
    assert.deepEqual(runs.stranded, []);
    const { [EXHAUSTED_FLAKY_CALL]: exhausted = 0, ...failures } =
      runs.failures;
    assert.deepEqual(failures, {}, JSON.stringify(runs.outcomes));
    assert.ok(
      exhausted <= EXHAUSTED_FLAKY_CALLS,
      `${exhausted} flaky calls failed five times`,
    );
  });

  it('keeps the worker and the Code runner up: no restart and no kill', async () => {
    const health = await restartsAndKills(started);
    record('health', health);
    assert.deepEqual(health.restarts, {});
    assert.deepEqual(health.events, []);
    assert.ok(!health.hostOomKills, `host OOM kills: ${health.hostOomKills}`);
  });

  it(`keeps the worker under ${PEAK_SHARE_OF_CAP * 100}% of its cap past warm-up, with no growth outside its heap`, async () => {
    const memory = {};
    for (const service of NODE_SERVICES) {
      const read = sampler.samples.map((sample) => sample.process?.[service]);
      const figures = read.filter((figure) => figure && !figure.error);
      const peak = (field) =>
        Math.max(...figures.map((figure) => figure[field]));
      const trend = (field) =>
        memoryTrend(
          sampler.samples,
          service,
          started + WARM_UP_MILLIS,
          (sample) => sample.process?.[service]?.[field],
        );
      memory[service] = {
        capMib: await containerLimitMib(server, service),
        processReads: figures.length,
        processReadErrors: [
          ...new Set(
            read.filter((figure) => figure?.error).map((f) => f.error),
          ),
        ],
        peak: Object.fromEntries(
          [
            'rssMib',
            'heapUsedMib',
            'heapTotalMib',
            'externalMib',
            'arrayBuffersMib',
            'outsideHeapMib',
            'threads',
          ].map((field) => [field, peak(field)]),
        ),
        trends: {
          container: memoryTrend(
            sampler.samples,
            service,
            started + WARM_UP_MILLIS,
          ),
          rss: trend('rssMib'),
          heapUsed: trend('heapUsedMib'),
          outsideHeap: trend('outsideHeapMib'),
        },
      };
    }
    record('memory', {
      ...memory,
      overTime: summarizeSamples(sampler.samples, started),
    });
    for (const service of NODE_SERVICES)
      assert.ok(
        memory[service].processReads >=
          PROCESS_READ_SHARE * sampler.samples.length,
        `${service}: ${JSON.stringify(memory[service].processReadErrors)}`,
      );
    // Start-up and the first burst of work settle within the warm-up.
    const worker = memory.worker;
    const busiest = worker.trends.rss.peakMib;
    assert.ok(
      busiest <= PEAK_SHARE_OF_CAP * worker.capMib,
      `worker peak past warm-up ${busiest} MiB of its ${worker.capMib} MiB cap`,
    );
    for (const trend of ['container', 'outsideHeap'])
      assert.ok(
        worker.trends[trend].mibPerHour < LEAK_MIB_PER_HOUR,
        `worker ${trend} grows: ${JSON.stringify(worker.trends[trend])}`,
      );
  });
});
