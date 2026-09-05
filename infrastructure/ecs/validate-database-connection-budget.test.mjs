import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { calculateDatabaseConnectionBudget } from './validate-database-connection-budget.mjs';

async function fixtures() {
  const [budget, workloads, autoscaling] = await Promise.all(
    [
      'database-connection-budget.json',
      'workloads.json',
      'autoscaling.json',
    ].map(async (name) =>
      JSON.parse(await readFile(resolve(import.meta.dirname, name), 'utf8')),
    ),
  );
  return { autoscaling, budget, workloads };
}

test('the declared regional connection budgets retain database headroom', async () => {
  const input = await fixtures();
  const result = calculateDatabaseConnectionBudget(
    input.budget,
    input.workloads,
    input.autoscaling,
  );

  assert.deepEqual(result, {
    maximum: 400,
    regions: {
      'eu-central-1': { required: 382, workloadConnections: 322 },
      'eu-west-1': { required: 366, workloadConnections: 306 },
    },
  });
});

test('autoscaling that exceeds PostgreSQL capacity fails closed', async () => {
  const input = await fixtures();
  input.autoscaling.services.worker.capacity['eu-central-1'].max = 23;

  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        input.budget,
        input.workloads,
        input.autoscaling,
      ),
    /requires 409 of 400 connections/u,
  );
});

test('undeclared pool sizes and workload drift fail closed', async () => {
  const input = await fixtures();
  delete input.workloads.workloads.api.environment.DATABASE_POOL_MAX;
  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        input.budget,
        input.workloads,
        input.autoscaling,
      ),
    /must declare numeric DATABASE_POOL_MAX/u,
  );

  const drifted = await fixtures();
  delete drifted.budget.workloads.recovery;
  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        drifted.budget,
        drifted.workloads,
        drifted.autoscaling,
      ),
    /workload inventory drifted/u,
  );
});
