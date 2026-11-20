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
import { containerLimitMib } from './process-memory.mjs';
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
// The worker drains itself at its cap (WORKER_MAX_RSS_BYTES); a busy worker
// keeps a quarter of it free.
const PEAK_SHARE_OF_CAP = 0.75;
// 30 MiB an hour fills the worker's cap in about 17 hours.
const LEAK_MIB_PER_HOUR = 30;
// Reading a process's figures can miss now and then (a busy event loop).
const PROCESS_READ_SHARE = 0.9;

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
    assert.deepEqual(runs.failures, {}, JSON.stringify(runs.outcomes));
  });

  it('keeps the worker and the Code runner up: no restart and no kill', async () => {
    const health = await restartsAndKills(started);
    record('health', health);
    assert.deepEqual(health.restarts, {});
    assert.deepEqual(health.events, []);
    assert.ok(!health.hostOomKills, `host OOM kills: ${health.hostOomKills}`);
  });

  it(`keeps the worker under ${PEAK_SHARE_OF_CAP * 100}% of its cap, with no growth outside its heap`, async () => {
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
    const worker = memory.worker;
    assert.ok(
      worker.peak.rssMib <= PEAK_SHARE_OF_CAP * worker.capMib,
      `worker peak ${worker.peak.rssMib} MiB of its ${worker.capMib} MiB cap`,
    );
    for (const trend of ['container', 'outsideHeap'])
      assert.ok(
        worker.trends[trend].mibPerHour < LEAK_MIB_PER_HOUR,
        `worker ${trend} grows: ${JSON.stringify(worker.trends[trend])}`,
      );
  });
});
