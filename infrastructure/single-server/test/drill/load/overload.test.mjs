import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkspace } from '../support/product.mjs';
import { createReport } from '../support/simulation-report.mjs';
import { destroyServer } from '../support/server.mjs';
import {
  checkRuns,
  percentile,
  restartsAndKills,
  startLatency,
  startSampler,
  summarizeSamples,
  waitForDrain,
} from './observer.mjs';
import { deployMinimumServer, signedInBrowser, sqlJson } from './stack.mjs';
import {
  approvePending,
  browse,
  createLedger,
  pace,
  publishLightHook,
  publishTeamWorkflows,
  sendDelivery,
  sleep,
  stopAllTraffic,
  startManualRun,
} from './traffic.mjs';

// Pushes the minimum-size stack past what it was sized for until something
// gives: webhook deliveries ramp from 2 to 160 a second into one workspace while
// another workspace's team keeps working. Then the flood stops. A safe failure
// refuses clearly with Retry-After, loses and duplicates nothing, keeps the
// other workspace working and recovers on its own. Rerun on Linux with Docker:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/load/overload.test.mjs

const STAGE_MINUTES = Number(process.env.OVERLOAD_STAGE_MINUTES ?? 3);
const RATES_PER_SECOND = [2, 5, 10, 20, 40, 80, 160];
// The rates a minimum server must survive by turning work away, not by dying.
const SHEDDING_RATES = [40, 80, 160];
// Each endpoint takes 600 deliveries a minute; sixteen let the ramp reach 160 a second.
const FLOOD_ENDPOINTS = 16;
// More unanswered deliveries than this and the driver, not the server, would limit.
const DRIVER_IN_FLIGHT = 2_000;
// What senders may hear under a flood: accepted, or turned away with Retry-After.
const FLOOD_ANSWERS = new Set(['202', '429', '503']);
// The share of the other workspace's reads that must still succeed while the
// API turns the flood away. One bound for the whole process admits a request
// about as often as throughput over offered load (about 36 of 160 a second at
// the top stage, measured 0.2), so this asks that reads keep working, not that
// they stay unaffected: per-workspace fairness is out of scope.
const READ_SHARE_FLOOR = 0.1;
const DELIVERY_TIMEOUT_MILLIS = 30_000;
const DRAIN_MILLIS = 40 * 60_000;
const RECOVERY_DELIVERIES = 20;
const RECOVERED_START_P95_MILLIS = 5_000;
// Signals that the stack is past its capacity, in the order they are checked.
const STRAIN = {
  requestP95Millis: 2_000,
  startP95Millis: 30_000,
};

const record = createReport();

describe('the minimum-size stack pushed past its capacity', () => {
  let setup;
  let server;
  let ledger;
  let sampler;
  let started;
  let team;
  let teamWorkflows;
  let flood;
  const stages = [];

  before(async () => {
    setup = await deployMinimumServer();
    server = setup.server;
  });
  after(async () => {
    await stopAllTraffic();
    await sampler?.stop();
    if (process.env.DRILL_KEEP !== 'true') await destroyServer();
  });

  it('ramps the flood stage by stage while another workspace keeps working', async () => {
    const { client, owner } = setup;
    team = await createWorkspace(client);
    teamWorkflows = await publishTeamWorkflows(client, team);
    flood = await createWorkspace(client);
    const endpoints = [];
    for (let index = 0; index < FLOOD_ENDPOINTS; index++)
      endpoints.push(await publishLightHook(client, flood));
    const reader = await signedInBrowser(server, owner);
    ledger = createLedger();
    started = Date.now();
    sampler = startSampler(server, { every: 10_000 });
    const background = [
      pace(15_000, () =>
        sendDelivery(
          ledger,
          client,
          'team webhook',
          team,
          teamWorkflows.codeHook,
        ),
      ),
      pace(60_000, () =>
        startManualRun(ledger, client, 'team approval', teamWorkflows.approval),
      ),
      pace(10_000, () => approvePending(ledger, client, team), { inFlight: 1 }),
      pace(5_000, () => browse(ledger, reader, team), { inFlight: 1 }),
    ];
    let next = 0;
    for (const rate of RATES_PER_SECOND) {
      const stageStarted = Date.now();
      const before = ledger.requests.length;
      const sender = pace(
        1_000 / rate,
        () =>
          sendDelivery(
            ledger,
            client,
            'flood webhook',
            flood,
            endpoints[next++ % endpoints.length],
            { timeout: DELIVERY_TIMEOUT_MILLIS },
          ),
        { jitter: 0, inFlight: DRIVER_IN_FLIGHT },
      );
      await sleep(STAGE_MINUTES * 60_000);
      await sender.stop();
      stages.push(
        await describeStage(rate, stageStarted, ledger.requests.slice(before)),
      );
      record('stages', { stages });
      console.log(`Stage at ${rate}/s: ${JSON.stringify(stages.at(-1))}`);
    }
    const floodEnded = Date.now();
    // The team keeps working a little longer: does it get back to normal?
    await sleep(2 * 60_000);
    await Promise.all(background.map((loop) => loop.stop()));
    const approver = pace(10_000, () => approvePending(ledger, client, team), {
      inFlight: 1,
    });
    const unfinished = await waitForDrain(server, DRAIN_MILLIS);
    await approver.stop();
    record('drain', {
      drainMillis: Date.now() - floodEnded,
      unfinishedAfterDrain: unfinished,
    });
    assert.equal(unfinished, 0, 'the backlog drains once the flood stops');
  });

  /** What one stage did to the senders, the queue and the other workspace. */
  async function describeStage(rate, stageStarted, requests) {
    const floodRequests = requests.filter((request) =>
      request.kind.startsWith('flood webhook'),
    );
    const teamRequests = requests.filter((request) =>
      request.kind.startsWith('team'),
    );
    const reads = requests.filter((request) =>
      ['run history', 'run page', 'workflow list', 'inbox'].includes(
        request.kind,
      ),
    );
    const count = (list, test) => list.filter(test).length;
    const statuses = {};
    for (const request of floodRequests)
      statuses[request.status] = (statuses[request.status] ?? 0) + 1;
    const database = await sqlJson(
      server,
      `select json_build_object(
        'floodStartP95Millis', (${startP95(flood, stageStarted)}),
        'teamStartP95Millis', (${startP95(team, stageStarted)}),
        'queuedRuns', (select count(*) from app.workflow_runs where status = 'queued'))`,
    );
    const memory = sampler.samples.filter(
      (sample) => sample.at >= stageStarted && sample.memory?.api,
    );
    const succeeded =
      reads.length -
      count(
        reads,
        (request) =>
          typeof request.status !== 'number' || request.status >= 400,
      );
    const stage = {
      ratePerSecond: rate,
      sent: floodRequests.length,
      statuses,
      floodP95Millis: percentile(
        floodRequests.map((request) => request.millis),
        0.95,
      ),
      teamRequestsFailed: count(
        teamRequests,
        (request) =>
          typeof request.status !== 'number' || request.status >= 400,
      ),
      readP95Millis: percentile(
        reads.map((request) => request.millis),
        0.95,
      ),
      readsFailed: reads.length - succeeded,
      readsSucceededShare:
        reads.length === 0 ? 1 : round2(succeeded / reads.length),
      apiPeakMib: Math.max(0, ...memory.map((sample) => sample.memory.api.mib)),
      apiAnonPeakMib: Math.max(
        0,
        ...memory.map((sample) => sample.inside?.api?.anonMib ?? 0),
      ),
      ...database,
    };
    return stage;
  }

  const round2 = (value) => Math.round(value * 100) / 100;

  const startP95 = (workspaceId, since) =>
    `select round(percentile_cont(0.95) within group (order by extract(epoch from started_at - created_at) * 1000))
     from app.workflow_runs where workspace_id = '${workspaceId}' and started_at is not null
       and created_at >= to_timestamp(${since / 1000})`;

  it('records what gave first', () => {
    const first = {};
    for (const stage of stages) {
      const at = stage.ratePerSecond;
      if ((stage.statuses[429] ?? 0) + (stage.statuses[503] ?? 0) > 0)
        first.refusals ??= at;
      if (
        Object.keys(stage.statuses).some(
          (status) => !/^(202|429|503)$/u.test(status),
        )
      )
        first.otherAnswers ??= at;
      if (stage.floodP95Millis > STRAIN.requestP95Millis)
        first.slowAdmission ??= at;
      if (stage.readP95Millis > STRAIN.requestP95Millis) first.slowReads ??= at;
      if (stage.floodStartP95Millis > STRAIN.startP95Millis)
        first.slowFloodStarts ??= at;
      if (stage.teamStartP95Millis > STRAIN.startP95Millis)
        first.slowTeamStarts ??= at;
      if (stage.readsFailed + stage.teamRequestsFailed > 0)
        first.teamAffected ??= at;
    }
    record('first to give', {
      byRatePerSecond: first,
      overTime: summarizeSamples(sampler.samples, started),
    });
  });

  // Without a bound across the process, a flood above about 40 a second got
  // the API killed at its 512 MiB cap and everything in flight answered 502.
  // Past its bound the API now answers 503 at once, and its glibc arenas are
  // capped so memory outside the heap stays down.
  it('answers every flood sender at 40, 80 and 160 a second with 202, 429 or 503', () => {
    const shedding = stages.filter((stage) =>
      SHEDDING_RATES.includes(stage.ratePerSecond),
    );
    assert.deepEqual(
      shedding.map((stage) => stage.ratePerSecond),
      SHEDDING_RATES,
      'every shedding stage ran',
    );
    const unexpected = Object.fromEntries(
      shedding.map((stage) => [
        stage.ratePerSecond,
        Object.fromEntries(
          Object.entries(stage.statuses).filter(
            ([status]) => !FLOOD_ANSWERS.has(status),
          ),
        ),
      ]),
    );
    record('unexpected flood answers', unexpected);
    assert.deepEqual(
      unexpected,
      Object.fromEntries(SHEDDING_RATES.map((rate) => [rate, {}])),
    );
  });

  it('keeps the other workspace reading while the flood is turned away', () => {
    const shares = Object.fromEntries(
      stages
        .filter((stage) => SHEDDING_RATES.includes(stage.ratePerSecond))
        .map((stage) => [stage.ratePerSecond, stage.readsSucceededShare]),
    );
    record('reads succeeded share', shares);
    for (const [rate, share] of Object.entries(shares))
      assert.ok(
        share >= READ_SHARE_FLOOR,
        `at ${rate}/s only ${share} of the team's reads succeeded`,
      );
  });

  it('refuses only clearly: 429 or 503 with Retry-After, never a 500 or a dropped connection', () => {
    const unsafe = {};
    for (const request of ledger.requests) {
      const refused = request.status === 429 || request.status === 503;
      const fine =
        (typeof request.status === 'number' && request.status < 400) ||
        (refused && request.retryAfter !== undefined);
      if (!fine) {
        const key = `${request.kind} ${request.status} ${request.problem ?? request.error ?? ''}`;
        unsafe[key] = (unsafe[key] ?? 0) + 1;
      }
    }
    record('unsafe answers', unsafe);
    assert.deepEqual(unsafe, {});
  });

  it('loses, duplicates and strands no accepted run', async () => {
    assert.ok(ledger, 'the load ran');
    const runs = await checkRuns(server, ledger);
    record('runs', runs);
    assert.deepEqual(runs.lost, []);
    assert.deepEqual(runs.unrequested, []);
    assert.deepEqual(runs.duplicated, []);
    assert.deepEqual(runs.deduplication, {
      webhookRunsWithoutKey: 0,
      keysWithSeveralRuns: 0,
      runsWithSeveralKeys: 0,
    });
    assert.deepEqual(runs.stranded, []);
    assert.deepEqual(runs.failures, {}, JSON.stringify(runs.outcomes));
  });

  it('kills and restarts nothing', async () => {
    const health = await restartsAndKills(started);
    record('restarts and kills', health);
    assert.deepEqual(health.restarts, {});
    assert.deepEqual(health.events, []);
    assert.ok(!health.hostOomKills, `host OOM kills: ${health.hostOomKills}`);
  });

  it('serves the other workspace normally again afterwards', async () => {
    const { client } = setup;
    const recovery = createLedger();
    const recoveryStarted = Date.now();
    await Promise.all(
      Array.from({ length: RECOVERY_DELIVERIES }, () =>
        sendDelivery(
          recovery,
          client,
          'recovery',
          team,
          teamWorkflows.codeHook,
        ),
      ),
    );
    const unfinished = await waitForDrain(server, 5 * 60_000);
    const runs = await checkRuns(server, recovery);
    const latency = await startLatency(server, recoveryStarted);
    record('recovery', {
      statuses: recovery.requests.map((request) => request.status),
      unfinished,
      latency: latency.overall,
    });
    assert.equal(unfinished, 0);
    assert.equal(recovery.runs.size, RECOVERY_DELIVERIES);
    assert.deepEqual(runs.lost, []);
    assert.ok(
      latency.overall.p95 <= RECOVERED_START_P95_MILLIS,
      JSON.stringify(latency.overall),
    );
  });
});
