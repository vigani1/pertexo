import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

type Observe = <T extends Record<string, unknown>>(
  statement: string,
) => Promise<T[]>;

function containerCommand(
  service: 'redis' | 'postgres',
  ...args: string[]
): string {
  return execFileSync('docker', ['compose', 'exec', '-T', service, ...args], {
    encoding: 'utf8',
  });
}

function redisCommands(): number {
  const stats = containerCommand(
    'redis',
    'sh',
    '-ec',
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli INFO commandstats',
  );
  let commands = 0;
  for (const match of stats.matchAll(/^cmdstat_([^:]+):calls=(\d+)/gmu)) {
    if (match[1] === 'info' || match[1] === 'auth' || match[1] === 'config')
      continue;
    commands += Number(match[2]);
  }
  return commands;
}

export async function readJ7Counters(
  observe: Observe,
  priorObserverReads: number,
) {
  const [snapshot] = await observe<{
    commits: string;
    rollbacks: string;
    statements: string;
  }>(
    `select xact_commit::text as commits, xact_rollback::text as rollbacks,
         (select coalesce(sum(s.calls),0)::text
            from pg_stat_statements s join pg_roles r on r.oid=s.userid
           where d.datid=s.dbid and s.toplevel and not r.rolsuper) as statements
       from pg_stat_database d where datname=current_database()`,
  );
  if (snapshot === undefined) throw new Error('PostgreSQL counters missing');
  const stat = containerCommand('postgres', 'cat', '/sys/fs/cgroup/cpu.stat');
  const cpuMicros = /usage_usec (\d+)/u.exec(stat)?.[1];
  if (cpuMicros === undefined)
    throw new Error('PostgreSQL cgroup CPU counters missing');
  const worker = process.cpuUsage();
  return {
    at: performance.now(),
    transactions:
      Number(snapshot.commits) +
      Number(snapshot.rollbacks) -
      priorObserverReads,
    statements: Number(snapshot.statements),
    redisCommands: redisCommands(),
    postgresCpuMs: Number(cpuMicros) / 1000,
    workerCpuMs: (worker.user + worker.system) / 1000,
  };
}

type Counters = Awaited<ReturnType<typeof readJ7Counters>>;
const COUNTERS = [
  'transactions',
  'statements',
  'redisCommands',
  'postgresCpuMs',
  'workerCpuMs',
] as const;
type Work = Record<(typeof COUNTERS)[number], number>;

function eachCounter(value: (key: keyof Work) => number): Work {
  return Object.fromEntries(COUNTERS.map((key) => [key, value(key)])) as Work;
}

export function counterRates(before: Counters, after: Counters): Work {
  return eachCounter(
    (key) => (after[key] - before[key]) / (after.at - before.at),
  );
}

export function measureBurst(
  before: Counters,
  after: Counters,
  idlePerMs: Work,
  runs: number,
) {
  const raw = eachCounter((key) => after[key] - before[key]);
  const perRun = eachCounter(
    (key) => (raw[key] - idlePerMs[key] * (after.at - before.at)) / runs,
  );
  return { raw, perRun };
}
