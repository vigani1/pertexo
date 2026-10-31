import { Queue } from 'bullmq';

import { delay } from './facts.js';
import type { Stack } from './stack.js';

const PUBLISH_LIMIT_MS = 60_000;

const connectionOf = (stack: Stack) => {
  const parsed = new URL(stack.redisUrl);
  return {
    db: stack.redisDatabase,
    host: parsed.hostname,
    password: decodeURIComponent(parsed.password),
    port: Number(parsed.port),
  };
};

async function withQueue<Result>(
  stack: Stack,
  name: string,
  work: (queue: Queue) => Promise<Result>,
): Promise<Result> {
  const queue = new Queue(name, { connection: connectionOf(stack) });
  try {
    await queue.waitUntilReady();
    return await work(queue);
  } finally {
    await queue.close();
  }
}

/** Holds a queue's jobs in Redis, so what is published there stays unconsumed. */
export const pauseQueue = (stack: Stack, name: string): Promise<void> =>
  withQueue(stack, name, (queue) => queue.pause());

export const resumeQueue = (stack: Stack, name: string): Promise<void> =>
  withQueue(stack, name, (queue) => queue.resume());

/** What Redis holds for this queue, in every state. */
export const queuedJobs = (stack: Stack, name: string): Promise<number> =>
  withQueue(stack, name, async (queue) =>
    Object.values(await queue.getJobCounts()).reduce(
      (total, count) => total + count,
      0,
    ),
  );

/**
 * Waits until the outbox holds at least this many events of each job kind and
 * all of them have reached Redis, so losing Redis then loses those jobs.
 */
export async function waitForPublished(
  stack: Stack,
  expected: Readonly<Record<string, number>>,
): Promise<void> {
  const deadline = Date.now() + PUBLISH_LIMIT_MS;
  for (;;) {
    const rows = await stack.sql<{
      job_name: string;
      total: number;
      waiting: number;
    }>(
      `select job_name, count(*)::int as total,
              count(*) filter (where published_at is null)::int as waiting
         from app.outbox_events
        where job_name = any($1::text[])
        group by job_name`,
      [Object.keys(expected)],
    );
    const ready = Object.entries(expected).every(([jobName, minimum]) => {
      const row = rows.find(({ job_name: name }) => name === jobName);
      return row !== undefined && row.total >= minimum && row.waiting === 0;
    });
    if (ready) return;
    if (Date.now() > deadline)
      throw new Error(`Jobs never reached Redis: ${JSON.stringify(rows)}`);
    await delay(100);
  }
}

export async function eventsOfAggregate(
  stack: Stack,
  aggregateId: string,
): Promise<number> {
  const [row] = await stack.sql<{ total: number }>(
    `select count(*)::int as total from app.outbox_events where aggregate_id=$1`,
    [aggregateId],
  );
  return row?.total ?? 0;
}

/** Waits until this run or attempt has this many events, all of them in Redis. */
export async function waitForAggregatePublished(
  stack: Stack,
  aggregateId: string,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + PUBLISH_LIMIT_MS;
  for (;;) {
    const [row] = await stack.sql<{ total: number; waiting: number }>(
      `select count(*)::int as total,
              count(*) filter (where published_at is null)::int as waiting
         from app.outbox_events where aggregate_id=$1`,
      [aggregateId],
    );
    if (row?.waiting === 0 && row.total >= minimum) return;
    if (Date.now() > deadline)
      throw new Error(`Events never reached Redis: ${JSON.stringify(row)}`);
    await delay(100);
  }
}

/** Waits until this many first steps are `ready`, their jobs on the way to Redis. */
export async function waitForReadyAttempts(
  stack: Stack,
  runIds: readonly string[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + PUBLISH_LIMIT_MS;
  for (;;) {
    const [row] = await stack.sql<{ ready: number }>(
      `select count(*)::int as ready
         from app.node_attempts a
         join app.node_runs n on n.id=a.node_run_id and n.workspace_id=a.workspace_id
        where n.workflow_run_id = any($1::uuid[]) and a.status='ready'`,
      [runIds],
    );
    if (row?.ready === count) return;
    if (Date.now() > deadline)
      throw new Error(`Attempts never became ready: ${JSON.stringify(row)}`);
    await delay(100);
  }
}
