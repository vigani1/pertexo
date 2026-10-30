import type { Stack } from './stack.js';

const TERMINAL = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

export type RunFacts = Readonly<{
  /** Attempt statuses in order, by step. */
  steps: Readonly<Record<string, readonly string[]>>;
  status: string;
}>;

/** What is stored about a run: its status, and each step's attempts. */
export async function runFacts(stack: Stack, runId: string): Promise<RunFacts> {
  const [run] = await stack.sql<{ status: string }>(
    `select status from app.workflow_runs where id=$1`,
    [runId],
  );
  const attempts = await stack.sql<{ node_id: string; status: string }>(
    `select n.node_id, a.status
       from app.node_attempts a
       join app.node_runs n on n.id=a.node_run_id and n.workspace_id=a.workspace_id
      where n.workflow_run_id=$1
      order by a.attempt_number`,
    [runId],
  );
  if (run === undefined) throw new Error(`Run ${runId} is not stored`);
  const steps: Record<string, string[]> = {};
  for (const { node_id: nodeId, status } of attempts)
    (steps[nodeId] ??= []).push(status);
  return { steps, status: run.status };
}

/** The workspace's capacity counter: how many active runs still hold a slot. */
export async function activeRuns(
  stack: Stack,
  workspaceId: string,
): Promise<number> {
  const [counter] = await stack.sql<{ active_runs: number }>(
    `select active_runs from app.workspace_execution_admission_counters where workspace_id=$1`,
    [workspaceId],
  );
  return counter?.active_runs ?? 0;
}

/**
 * Waits for every run to end, up to the limit. It never throws on a stuck run:
 * the scenario keeps what it saw and each test asserts its own part. Queries that
 * fail during an outage count as "not ended yet".
 */
export async function waitForRunsToEnd(
  stack: Stack,
  runIds: readonly string[],
  limitMs: number,
): Promise<Readonly<Record<string, RunFacts>>> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const facts = await Promise.all(
      runIds.map(async (id) => runFacts(stack, id)),
    ).catch(() => undefined);
    const everyRunEnded =
      facts?.every(({ status }) => TERMINAL.has(status)) === true;
    if (facts !== undefined && (everyRunEnded || Date.now() > deadline))
      return Object.fromEntries(
        runIds.map((id, index) => [id, facts[index] as RunFacts]),
      );
    if (facts === undefined && Date.now() > deadline + 60_000)
      throw new Error('Postgres did not answer after the scenario ended');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function required<Value>(value: Value | undefined, name: string): Value {
  if (value === undefined) throw new Error(`The scenario has no ${name}`);
  return value;
}

/** One named run's facts, from what a scenario kept. */
export function factsOfRun(
  facts: Readonly<Record<string, RunFacts>>,
  runs: Readonly<Record<string, string>>,
  name: string,
): RunFacts {
  return required(facts[required(runs[name], name)], name);
}

export const delay = (millis: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, millis));
