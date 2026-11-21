import { docker, mustDocker } from '../support/process.mjs';
import { project } from '../support/server.mjs';
import { nodeProcessMemory } from './process-memory.mjs';
import { SERVING_SERVICES, hostMemory, sql, sqlJson } from './stack.mjs';
import { sleep } from './traffic.mjs';

// What an operator would watch during the load, sampled from outside the
// product: container memory, the run queue in PostgreSQL and BullMQ, database
// size and dead rows, Redis memory. And afterwards, the database checked
// against the driver's ledger: every accepted run there once, none stranded.

export const BUCKET_MILLIS = 5 * 60_000;
// The tables that grow with every run; migration 0122 tunes their autovacuum.
const HOT_TABLES = [
  'workflow_runs',
  'node_runs',
  'node_attempts',
  'run_checkpoints',
  'run_events',
  'outbox_events',
  'inbox_receipts',
  'webhook_trigger_deliveries',
];
const UNFINISHED = ['queued', 'running', 'waiting'];
const MIB = 1024 * 1024;
const UNITS = { B: 1, KiB: 1024, MiB: MIB, GiB: 1024 * MIB, kB: 1000 };
const bytes = (text) => {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/u.exec(text.trim());
  return match ? Number(match[1]) * (UNITS[match[2]] ?? 1) : null;
};

/**
 * Samples the stack every `every` ms until stopped; returns the samples. With
 * `processes`, also reads those Node services' own memory figures.
 */
export function startSampler(server, { every = 15_000, processes = [] } = {}) {
  const samples = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        const [memory, host, database, redis, inside] = await Promise.all([
          serviceUsage(),
          hostMemory(),
          databaseState(server),
          redisState(server),
          insideNodeServices(server),
        ]);
        const sample = { at: started, memory, host, database, redis, inside };
        // After the container figures, so its own brief work never shows in them.
        if (processes.length > 0) sample.process = {};
        for (const service of processes)
          sample.process[service] = await nodeProcessMemory(
            server,
            service,
          ).catch((error) => ({ error: String(error.message).slice(0, 300) }));
        samples.push(sample);
      } catch (error) {
        samples.push({ at: started, error: String(error.message) });
      }
      await sleep(Math.max(0, every - (Date.now() - started)));
    }
  })();
  return {
    samples,
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

async function serviceUsage() {
  const result = await mustDocker([
    'stats',
    '--no-stream',
    '--format',
    '{{json .}}',
    ...(await projectContainers()).map(({ id }) => id),
  ]);
  const usage = {};
  for (const line of result.split('\n').filter(Boolean)) {
    const stat = JSON.parse(line);
    const service = serviceOf(stat.Name);
    usage[service] = {
      mib: round(bytes(stat.MemUsage.split('/')[0]) / MIB),
      cpu: Number.parseFloat(stat.CPUPerc),
    };
  }
  return usage;
}

// Where a Node service's memory goes, from its own cgroup and network
// namespace: heap and buffers are anon, socket buffers are sock.
const MEMORY_STAT_FIELDS = ['anon', 'file', 'kernel', 'sock', 'shmem'];
async function insideNodeServices(server) {
  const inside = {};
  for (const service of ['api', 'worker', 'code-runner']) {
    const result = await docker([
      'exec',
      await server.containerOf(service),
      'sh',
      '-c',
      'cat /sys/fs/cgroup/memory.stat; echo connections $(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l)',
    ]);
    if (result.status !== 0) continue;
    const stat = Object.fromEntries(
      result.stdout.split('\n').map((line) => line.split(' ')),
    );
    inside[service] = {
      ...Object.fromEntries(
        MEMORY_STAT_FIELDS.map((field) => [
          `${field}Mib`,
          round(Number(stat[field]) / MIB),
        ]),
      ),
      connections: Number(stat.connections),
    };
  }
  return inside;
}

const serviceOf = (name) =>
  name.replace(/^\//u, '').replace(`${project}-`, '').replace(/-\d+$/u, '');

async function projectContainers() {
  const listed = await mustDocker([
    'ps',
    '--all',
    '--format',
    '{{.ID}} {{.Names}}',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  return listed
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, name] = line.split(' ');
      return { id, service: serviceOf(name) };
    });
}

const databaseState = (server) =>
  sqlJson(
    server,
    `select json_build_object(
      'runs', (select json_object_agg(status, count) from (select status, count(*) from app.workflow_runs group by status) s),
      'bytes', pg_database_size(current_database()),
      'connections', (select count(*) from pg_stat_activity where datname = current_database()),
      'tables', (select json_object_agg(relname, json_build_object(
        'live', n_live_tup, 'dead', n_dead_tup,
        'autovacuums', autovacuum_count, 'autoanalyzes', autoanalyze_count,
        'lastAutovacuum', last_autovacuum))
        from pg_stat_user_tables where schemaname = 'app' and relname in (${HOT_TABLES.map((table) => `'${table}'`).join(',')})))`,
  );

// BullMQ keeps each queue's waiting and delayed jobs under these suffixes.
const QUEUE_DEPTH_SCRIPT = `
local out = {}
for _, state in ipairs({'wait', 'active', 'delayed', 'prioritized', 'paused', 'waiting-children'}) do
  for _, key in ipairs(redis.call('KEYS', '*:' .. state)) do
    local kind = redis.call('TYPE', key).ok
    local size = 0
    if kind == 'list' then size = redis.call('LLEN', key) elseif kind == 'zset' then size = redis.call('ZCARD', key) end
    table.insert(out, key)
    table.insert(out, size)
  end
end
return out`;

async function redisState(server) {
  const redis = await server.containerOf('redis');
  const cli = (args) =>
    mustDocker([
      'exec',
      redis,
      'sh',
      '-c',
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning "$@"',
      '--',
      ...args,
    ]);
  const info = Object.fromEntries(
    (await cli(['INFO', 'memory']))
      .split('\n')
      .map((line) => line.trim().split(':'))
      .filter((pair) => pair.length === 2),
  );
  const lines = (await cli(['EVAL', QUEUE_DEPTH_SCRIPT, '0'])).split('\n');
  const queues = {};
  for (let index = 0; index + 1 < lines.length; index += 2)
    if (Number(lines[index + 1]) > 0)
      queues[lines[index].replace(/^[^:]*:/u, '')] = Number(lines[index + 1]);
  return {
    usedMib: round(Number(info.used_memory) / MIB),
    peakMib: round(Number(info.used_memory_peak) / MIB),
    queues,
  };
}

/** Waits until no run is queued, running or waiting, or the time is up. */
export async function waitForDrain(server, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const unfinished = Number(
      await sql(
        server,
        `select count(*) from app.workflow_runs where status in ('queued','running','waiting')`,
      ),
    );
    if (unfinished === 0 || Date.now() > deadline) return unfinished;
    await sleep(5_000);
  }
}

/**
 * The database against the ledger: runs the driver was promised but the
 * database lacks (lost), webhook or manual runs nobody asked for, one event
 * with two runs (duplicated), and runs that never ended (stranded).
 */
export async function checkRuns(server, ledger) {
  const rows = await sqlJson(
    server,
    `select coalesce(json_agg(json_build_object('id', r.id, 'status', r.status, 'trigger', r.trigger_type,
        'error', coalesce((select string_agg(n.node_id || ' ' || n.status || ' ' || coalesce(n.safe_error_code, ''), '; ')
          from app.node_runs n where n.workflow_run_id = r.id and n.status not in ('succeeded', 'skipped')), r.error_summary))), '[]')
     from app.workflow_runs r where r.trigger_type <> 'test'`,
  );
  const stored = new Map(rows.map((row) => [row.id, row]));
  const lost = [...ledger.runs.keys()].filter((id) => !stored.has(id));
  // A manual run always answers its starter; a webhook answer can be lost.
  const unrequested = rows.filter(
    (row) => row.trigger === 'manual' && !ledger.runs.has(row.id),
  );
  const unacknowledged = rows.filter(
    (row) => row.trigger === 'webhook' && !ledger.runs.has(row.id),
  ).length;
  const duplicated = [...ledger.eventRuns].filter(([, ids]) => ids.size > 1);
  // A sender whose answer was lost never learns the run's id, so the database
  // proves the rest: each webhook run belongs to one stored delivery key.
  const deduplication = await sqlJson(
    server,
    `select json_build_object(
      'webhookRunsWithoutKey', (select count(*) from app.workflow_runs r where r.trigger_type = 'webhook'
        and not exists (select 1 from app.webhook_trigger_replay_records k where k.workflow_run_id = r.id)),
      'keysWithSeveralRuns', (select count(*) from (select 1 from app.webhook_trigger_replay_records
        where workflow_run_id is not null group by endpoint_id, dedupe_key_hash having count(distinct workflow_run_id) > 1) d),
      'runsWithSeveralKeys', (select count(*) from (select 1 from app.webhook_trigger_replay_records
        where workflow_run_id is not null group by workflow_run_id having count(*) > 1) d))`,
  );
  const stranded = rows.filter((row) => UNFINISHED.includes(row.status));
  const outcomes = {};
  const failures = {};
  for (const row of rows) {
    const kind = ledger.runs.get(row.id)?.kind ?? row.trigger;
    outcomes[kind] ??= {};
    outcomes[kind][row.status] = (outcomes[kind][row.status] ?? 0) + 1;
    if (row.status !== 'succeeded') {
      const key = `${kind}: ${row.status}: ${row.error ?? ''}`.slice(0, 200);
      failures[key] = (failures[key] ?? 0) + 1;
    }
  }
  return {
    stored: rows.length,
    accepted: ledger.runs.size,
    lost,
    unrequested: unrequested.map((row) => row.id),
    unacknowledgedWebhookRuns: unacknowledged,
    deduplication,
    duplicated: duplicated.map(([eventId, ids]) => ({
      eventId,
      runs: [...ids],
    })),
    stranded: stranded.map(({ id, status, trigger }) => ({
      id,
      status,
      trigger,
    })),
    outcomes,
    failures,
  };
}

/** Each schedule's minutes: one occurrence each, none missing, each with its run. */
export const checkSchedules = (server) =>
  sqlJson(
    server,
    `select coalesce(json_agg(row_to_json(s)), '[]') from (
      select trigger_id as trigger,
        count(*) as occurrences,
        count(*) filter (where disposition = 'accepted') as accepted,
        count(*) filter (where disposition <> 'accepted') as "notAccepted",
        count(*) - count(distinct scheduled_at) as duplicates,
        count(*) filter (where disposition = 'accepted' and not exists (
          select 1 from app.workflow_runs r where r.id = o.workflow_run_id)) as "acceptedWithoutRun",
        round(extract(epoch from max(scheduled_at) - min(scheduled_at)) / 60)::int + 1 as "minutesSpanned"
      from app.trigger_schedule_occurrences o group by trigger_id) s`,
  );

/** Run start latency (created → started), overall and per five minutes. */
export const startLatency = (server, sinceMillis) =>
  sqlJson(
    server,
    `with runs as (
       select created_at, trigger_type, extract(epoch from started_at - created_at) * 1000 as millis
       from app.workflow_runs
       where started_at is not null and trigger_type <> 'test'
         and created_at >= to_timestamp(${sinceMillis / 1000})),
     stats as (
       select count(*) as runs,
         round(percentile_cont(0.5) within group (order by millis)) as p50,
         round(percentile_cont(0.95) within group (order by millis)) as p95,
         round(percentile_cont(0.99) within group (order by millis)) as p99,
         round(max(millis)) as max
       from runs)
     select json_build_object(
       'overall', (select row_to_json(stats) from stats),
       'byTrigger', (select json_object_agg(trigger_type, row_to_json(t)) from (
          select trigger_type, count(*) as runs,
            round(percentile_cont(0.5) within group (order by millis)) as p50,
            round(percentile_cont(0.95) within group (order by millis)) as p95,
            round(percentile_cont(0.99) within group (order by millis)) as p99
          from runs group by trigger_type) t),
       'byBucket', (select json_agg(row_to_json(b) order by b.minute) from (
          select round((extract(epoch from created_at) * 1000 - ${sinceMillis}) / ${BUCKET_MILLIS}) * ${BUCKET_MILLIS / 60_000} as minute,
            count(*) as runs,
            round(percentile_cont(0.5) within group (order by millis)) as p50,
            round(percentile_cont(0.95) within group (order by millis)) as p95,
            round(percentile_cont(0.99) within group (order by millis)) as p99
          from runs group by 1) b))`,
  );

/** Restarts and kernel OOM kills of the stack's containers since `sinceMillis`. */
export async function restartsAndKills(sinceMillis) {
  const containers = await projectContainers();
  const restarts = {};
  for (const { id, service } of containers) {
    const [count, killed] = (
      await mustDocker([
        'inspect',
        '--format',
        '{{.RestartCount}} {{.State.OOMKilled}}',
        id,
      ])
    ).split(' ');
    if (Number(count) > 0 || killed === 'true')
      restarts[service] = { restarts: Number(count), oomKilled: killed };
  }
  const events = await docker([
    'events',
    '--since',
    new Date(sinceMillis).toISOString(),
    '--until',
    new Date().toISOString(),
    '--filter',
    'event=oom',
    '--filter',
    'event=die',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    '{{.Action}} {{index .Actor.Attributes "com.docker.compose.service"}} {{index .Actor.Attributes "exitCode"}}',
  ]);
  // The kernel can kill one process inside a container (a PostgreSQL backend)
  // without killing the container; the host cgroup counts every kill.
  const host = await hostMemory();
  return {
    restarts,
    events: events.stdout.split('\n').filter(Boolean),
    hostOomKills: host?.oomKills ?? null,
    hostPeakMib: host?.peakMib ?? null,
  };
}

/**
 * Least-squares slope of a service's memory, in MiB per hour, after `from`:
 * its container's by default, or what `read` takes from each sample.
 */
export function memoryTrend(
  samples,
  service,
  from = 0,
  read = (sample) => sample.memory?.[service]?.mib,
) {
  const points = samples
    .filter((sample) => sample.at >= from && Number.isFinite(read(sample)))
    .map((sample) => [sample.at / 3_600_000, read(sample)]);
  if (points.length < 3) return null;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const covariance = points.reduce(
    (sum, [x, y]) => sum + (x - meanX) * (y - meanY),
    0,
  );
  const variance = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  const tenth = Math.max(1, Math.floor(points.length / 10));
  const mean = (slice) =>
    slice.reduce((sum, [, y]) => sum + y, 0) / slice.length;
  return {
    mibPerHour: round(covariance / variance),
    firstTenthMib: round(mean(points.slice(0, tenth))),
    lastTenthMib: round(mean(points.slice(-tenth))),
    peakMib: round(Math.max(...points.map(([, y]) => y))),
  };
}

/** Five-minute rows an operator can read: memory, queue, database, Redis. */
export function summarizeSamples(samples, since) {
  const buckets = new Map();
  let previousHostSample;
  for (const sample of samples.filter((candidate) => candidate.memory)) {
    const minute =
      Math.floor((sample.at - since) / BUCKET_MILLIS) *
      (BUCKET_MILLIS / 60_000);
    const row = buckets.get(minute) ?? { minute, memoryMib: {} };
    for (const service of SERVING_SERVICES)
      if (sample.memory[service])
        row.memoryMib[service] = Math.max(
          row.memoryMib[service] ?? 0,
          sample.memory[service].mib,
        );
    const runs = sample.database.runs ?? {};
    row.queuedRunsMax = Math.max(row.queuedRunsMax ?? 0, runs.queued ?? 0);
    row.runningRunsMax = Math.max(row.runningRunsMax ?? 0, runs.running ?? 0);
    row.waitingRunsMax = Math.max(row.waitingRunsMax ?? 0, runs.waiting ?? 0);
    const bullDepth = Object.entries(sample.redis.queues)
      .filter(([key]) => !key.endsWith(':active'))
      .reduce((sum, [, size]) => sum + size, 0);
    row.bullWaitingMax = Math.max(row.bullWaitingMax ?? 0, bullDepth);
    for (const [service, stat] of Object.entries(sample.inside ?? {})) {
      row.inside ??= {};
      const kept = row.inside[service];
      if (!kept || stat.anonMib > kept.anonMib) row.inside[service] = stat;
    }
    for (const [service, stat] of Object.entries(sample.process ?? {})) {
      if (stat.error) continue;
      row.process ??= {};
      const kept = row.process[service];
      if (!kept || stat.rssMib > kept.rssMib) row.process[service] = stat;
    }
    if (sample.host) {
      row.hostMib = Math.max(row.hostMib ?? 0, sample.host.currentMib);
      row.hostOomKills = sample.host.oomKills;
      if (sample.host.cpuMicros !== null) {
        if (previousHostSample) {
          const cpuMicros =
            sample.host.cpuMicros - previousHostSample.host.cpuMicros;
          const elapsedMicros = (sample.at - previousHostSample.at) * 1_000;
          // CPU percentages use 100% for one core, as Docker stats does.
          row.hostCpuPercentMax = Math.max(
            row.hostCpuPercentMax ?? 0,
            round((cpuMicros / elapsedMicros) * 100),
          );
        }
        previousHostSample = sample;
      }
    }
    row.databaseMib = round(sample.database.bytes / MIB);
    row.connectionsMax = Math.max(
      row.connectionsMax ?? 0,
      sample.database.connections,
    );
    row.redisMib = sample.redis.usedMib;
    row.deadRows = Object.fromEntries(
      Object.entries(sample.database.tables ?? {}).map(([table, stat]) => [
        table,
        `${stat.dead}/${stat.live}`,
      ]),
    );
    buckets.set(minute, row);
  }
  return [...buckets.values()];
}

/** Request counts, refusals, errors and p95 per five minutes and per kind. */
export function summarizeRequests(requests, since) {
  const byKind = {};
  const byBucket = new Map();
  for (const request of requests) {
    const kind = (byKind[request.kind] ??= {
      total: 0,
      statuses: {},
      millis: [],
    });
    kind.total++;
    kind.statuses[request.status] = (kind.statuses[request.status] ?? 0) + 1;
    kind.millis.push(request.millis);
    const minute =
      Math.floor((request.at - since) / BUCKET_MILLIS) *
      (BUCKET_MILLIS / 60_000);
    const row = byBucket.get(minute) ?? {
      minute,
      requests: 0,
      refused: 0,
      errors: 0,
      millis: [],
    };
    row.requests++;
    if (request.status === 429 || request.status === 503) row.refused++;
    else if (typeof request.status !== 'number' || request.status >= 400)
      row.errors++;
    row.millis.push(request.millis);
    byBucket.set(minute, row);
  }
  for (const kind of Object.values(byKind)) {
    kind.p95Millis = percentile(kind.millis, 0.95);
    delete kind.millis;
  }
  const buckets = [...byBucket.values()].map(({ millis, ...row }) => ({
    ...row,
    errorRate: round(row.errors / row.requests, 4),
    p95Millis: percentile(millis, 0.95),
  }));
  return { byKind, byBucket: buckets };
}

export function percentile(values, share) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}

const round = (value, places = 1) =>
  Math.round(value * 10 ** places) / 10 ** places;
