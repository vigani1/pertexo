import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkspace } from '../support/product.mjs';
import { createReport } from '../support/simulation-report.mjs';
import { destroyServer } from '../support/server.mjs';
import { verifySetExecution } from './inline-qualification.mjs';
import {
  checkRuns,
  checkSchedules,
  memoryTrend,
  restartsAndKills,
  startLatency,
  startSampler,
  summarizeRequests,
  summarizeSamples,
  waitForDrain,
} from './observer.mjs';
import {
  HOST_SIZE,
  J1_CAPS,
  SIZING,
  SERVING_SERVICES,
  deployMinimumServer,
  signedInBrowser,
  targetCounts,
} from './stack.mjs';
import {
  approvePending,
  browse,
  createLedger,
  pace,
  publishTeamWorkflows,
  sendDelivery,
  sleep,
  stopAllTraffic,
  startManualRun,
  uploadAndCheck,
} from './traffic.mjs';

// A small team's hour on the production stack at the documented minimum size
// (4 GiB, 2 vCPUs): webhooks at a steady rate with bursts, schedules, waits,
// approvals, callbacks, Code, a flaky outside API, uploads and people reading
// the run history, in three workspaces at once. Rerun on Linux with Docker:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   LOAD_MINUTES=60 node --test infrastructure/single-server/test/drill/load/steady.test.mjs

const MINUTES = Number(process.env.LOAD_MINUTES ?? 60);
const WORKSPACES = 3;
const BROWSERS = 3;
// Every mix rate below is per workspace.
const EVERY = {
  codeDelivery: 15_000,
  httpDelivery: 30_000,
  callback: 60_000,
  timedWait: 90_000,
  approval: 90_000,
  python: 180_000,
  approver: 10_000,
};
const BURST = { every: 5 * 60_000, deliveries: 20 };
const UPLOAD_EVERY = 30_000;
const BROWSE_EVERY = 5_000;
// A sender that resends now and then, as one does after a lost answer.
const RESEND_SHARE = 0.05;
// After the traffic stops: the longest wait (60 s), callback (5 s) and approval.
const DRAIN_MILLIS = 10 * 60_000;
// Startup, JIT and pools settle in the first minutes; a leak shows after.
const WARM_UP_MILLIS = Math.min(10, MINUTES / 6) * 60_000;
// What a person expects of an idle-ish server: a run starts within seconds.
const START_P95_MILLIS = 5_000;
// 30 MiB an hour is a full API or worker cap in about 17 hours.
const LEAK_MIB_PER_HOUR = 30;
const DEAD_ROW_SHARE = 0.2;

const record = createReport();

describe(`the production stack at its minimum size under ${MINUTES} minutes of mixed load`, () => {
  let server;
  let started;
  let ledger;
  let sampler;
  let runs;
  let latency;
  let setup;

  before(async () => {
    setup = await deployMinimumServer();
    server = setup.server;
  });
  after(async () => {
    await stopAllTraffic();
    await sampler?.stop();
    if (process.env.DRILL_KEEP !== 'true') await destroyServer();
  });

  it(`carries the mix for ${MINUTES} minutes and drains`, async () => {
    const { client, owner } = setup;
    const workspaces = [];
    for (let index = 0; index < WORKSPACES; index++) {
      const workspaceId = await createWorkspace(client);
      workspaces.push({
        workspaceId,
        workflows: await publishTeamWorkflows(client, workspaceId),
      });
    }
    const browsers = [];
    for (let index = 0; index < BROWSERS; index++)
      browsers.push(await signedInBrowser(server, owner));
    ledger = createLedger();
    started = Date.now();
    sampler = startSampler(server);
    const loops = [];
    for (const { workspaceId, workflows } of workspaces) {
      const deliver = (kind, webhook) => () =>
        sendDelivery(ledger, client, kind, workspaceId, webhook, {
          resendShare: RESEND_SHARE,
        });
      const manual = (kind, workflow) => () =>
        startManualRun(ledger, client, kind, workflow);
      loops.push(
        pace(EVERY.codeDelivery, deliver('code webhook', workflows.codeHook)),
        pace(EVERY.httpDelivery, deliver('http webhook', workflows.httpHook)),
        pace(EVERY.callback, manual('callback', workflows.callback)),
        pace(EVERY.timedWait, manual('timed wait', workflows.timedWait)),
        pace(EVERY.approval, manual('approval', workflows.approval)),
        pace(EVERY.python, manual('python', workflows.python)),
        pace(
          EVERY.approver,
          () => approvePending(ledger, client, workspaceId),
          {
            inFlight: 1,
          },
        ),
      );
    }
    const pick = () =>
      workspaces[Math.floor(Math.random() * workspaces.length)].workspaceId;
    loops.push(
      pace(UPLOAD_EVERY, () => uploadAndCheck(ledger, client, pick())),
      pace(
        BURST.every,
        () =>
          Promise.all(
            Array.from({ length: BURST.deliveries }, () =>
              sendDelivery(
                ledger,
                client,
                'burst webhook',
                workspaces[0].workspaceId,
                workspaces[0].workflows.codeHook,
              ),
            ),
          ),
        { jitter: 0 },
      ),
      ...browsers.map((browser) =>
        pace(BROWSE_EVERY, () => browse(ledger, browser, pick()), {
          inFlight: 1,
        }),
      ),
    );
    await sleep(MINUTES * 60_000);
    // Approvals keep being worked while the rest drains.
    const approvers = workspaces.map(({ workspaceId }) =>
      pace(EVERY.approver, () => approvePending(ledger, client, workspaceId), {
        inFlight: 1,
      }),
    );
    await Promise.all(loops.map((loop) => loop.stop()));
    await Promise.all(
      workspaces.map(({ workflows }) =>
        disableSchedule(client, workflows.schedule),
      ),
    );
    const trafficEnded = Date.now();
    const unfinished = await waitForDrain(server, DRAIN_MILLIS);
    await Promise.all(approvers.map((loop) => loop.stop()));
    await sampler.stop();
    record('steady load', {
      minutes: MINUTES,
      workspaces: WORKSPACES,
      browsers: BROWSERS,
      sizing: SIZING,
      size: SIZING === 'host' ? HOST_SIZE : J1_CAPS,
      drainMillis: Date.now() - trafficEnded,
      unfinishedAfterDrain: unfinished,
    });
    assert.equal(unfinished, 0, 'every run ends once the traffic stops');
  });

  it('loses, duplicates and strands no run', async () => {
    assert.ok(ledger, 'the load ran');
    runs = await checkRuns(server, ledger);
    const schedules = await checkSchedules(server);
    record('runs', { ...runs, schedules, target: await targetCounts(server) });
    assert.deepEqual(runs.lost, [], 'accepted runs missing from the database');
    assert.deepEqual(runs.unrequested, [], 'runs nobody asked for');
    assert.deepEqual(runs.duplicated, [], 'one event, several runs');
    assert.deepEqual(runs.deduplication, {
      webhookRunsWithoutKey: 0,
      keysWithSeveralRuns: 0,
      runsWithSeveralKeys: 0,
    });
    assert.deepEqual(runs.stranded, [], 'runs that never ended');
    assert.equal(schedules.length, WORKSPACES, JSON.stringify(schedules));
    for (const schedule of schedules) {
      assert.equal(schedule.duplicates, 0, JSON.stringify(schedule));
      assert.equal(schedule.acceptedWithoutRun, 0, JSON.stringify(schedule));
      assert.equal(schedule.notAccepted, 0, JSON.stringify(schedule));
      assert.ok(
        schedule.occurrences >= schedule.minutesSpanned,
        `a schedule missed minutes: ${JSON.stringify(schedule)}`,
      );
    }
  });

  it('executes Set in the selected mode', async () => {
    await verifySetExecution(server, record);
  });

  it('ends every run as it should: the flaky API retried, the waits resumed', () => {
    assert.deepEqual(runs.failures, {}, JSON.stringify(runs.outcomes));
  });

  it('answers every request without an error or a refusal', () => {
    const requests = summarizeRequests(ledger.requests, started);
    record('requests', requests);
    const failed = ledger.requests.filter(
      (request) => typeof request.status !== 'number' || request.status >= 400,
    );
    const shown = {};
    for (const request of failed) {
      const key = `${request.kind} ${request.status} ${request.problem ?? request.error ?? ''}`;
      shown[key] = (shown[key] ?? 0) + 1;
    }
    assert.deepEqual(shown, {});
  });

  it(`starts runs promptly: p95 under ${START_P95_MILLIS} ms`, async () => {
    latency = await startLatency(server, started);
    record('run start latency', latency);
    assert.ok(
      latency.overall.p95 <= START_P95_MILLIS,
      JSON.stringify(latency.overall),
    );
  });

  it('keeps every service inside its cap, with no restart, kill or leak', async () => {
    const health = await restartsAndKills(started);
    const trends = Object.fromEntries(
      SERVING_SERVICES.map((service) => [
        service,
        memoryTrend(sampler.samples, service, started + WARM_UP_MILLIS),
      ]),
    );
    record('resources', {
      ...health,
      memoryTrends: trends,
      overTime: summarizeSamples(sampler.samples, started),
      samplingErrors: sampler.samples.filter((sample) => sample.error).length,
    });
    assert.deepEqual(health.restarts, {});
    assert.deepEqual(health.events, []);
    assert.ok(!health.hostOomKills, `host OOM kills: ${health.hostOomKills}`);
    for (const service of ['api', 'worker'])
      assert.ok(
        trends[service].mibPerHour < LEAK_MIB_PER_HOUR,
        `${service} grows: ${JSON.stringify(trends[service])}`,
      );
  });

  it('keeps dead rows in check: autovacuum runs on the busy tables', () => {
    const last = sampler.samples.findLast((sample) => sample.database);
    const tables = last.database.tables;
    for (const table of ['workflow_runs', 'node_runs', 'node_attempts']) {
      const stat = tables[table];
      assert.ok(stat.autovacuums > 0, `${table}: ${JSON.stringify(stat)}`);
      assert.ok(
        stat.dead <= DEAD_ROW_SHARE * Math.max(stat.live, 1),
        `${table}: ${JSON.stringify(stat)}`,
      );
    }
  });
});

async function disableSchedule(client, workflow) {
  // An active schedule can queue a run between the drain and ledger reads.
  const triggers = await client.get(`${workflow}/triggers/schedules`);
  assert.equal(triggers.status, 200, triggers.text);
  assert.equal(triggers.json.items.length, 1, triggers.text);
  const [{ id }] = triggers.json.items;
  const disabled = await client.post(
    `${workflow}/triggers/${id}/schedule/disable`,
    {},
  );
  assert.equal(disabled.status, 200, disabled.text);
}
