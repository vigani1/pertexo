import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { calculateDatabaseConnectionBudget } from './validate-database-connection-budget.mjs';

async function fixtures() {
  const [budget, workloads, autoscaling, externalPlatform] = await Promise.all(
    [
      'database-connection-budget.json',
      'workloads.json',
      'autoscaling.json',
      'external-platform-contract.json',
    ].map(async (name) =>
      JSON.parse(await readFile(resolve(import.meta.dirname, name), 'utf8')),
    ),
  );
  return { autoscaling, budget, externalPlatform, workloads };
}

function controlledServiceFixture(names, databaseMaximumConnections) {
  const workloads = { schemaVersion: 1, workloads: {} };
  const budget = {
    schemaVersion: 1,
    databaseMaximumConnections,
    reservedAdministrationConnections: 0,
    regionalFailoverHeadroomConnections: 0,
    externalPooler: { mode: 'none', maximumBackendConnections: 0 },
    workloads: {},
  };
  const autoscaling = { schemaVersion: 1, services: {} };
  for (const name of names) {
    workloads.workloads[name] = {
      kind: 'service',
      desiredCount: { 'eu-central-1': 1, 'eu-west-1': 1 },
      environment: { DATABASE_POOL_MAX: '1' },
    };
    budget.workloads[name] = {
      replicas: 'autoscaling',
      poolEnvironment: ['DATABASE_POOL_MAX'],
      monitorConnectionsPerPool: 0,
      transientConnectionsPerTask: 0,
    };
    autoscaling.services[name] = {
      capacity: {
        'eu-central-1': { min: 1, max: 1 },
        'eu-west-1': { min: 1, max: 1 },
      },
    };
  }
  return {
    autoscaling,
    budget,
    externalPlatform: { services: { maximumPercent: 200 } },
    workloads,
  };
}

test('the declared regional connection budgets retain database headroom', async () => {
  const input = await fixtures();
  const result = calculateDatabaseConnectionBudget(
    input.budget,
    input.workloads,
    input.autoscaling,
    input.externalPlatform,
  );

  assert.deepEqual(result, {
    maximum: 400,
    regions: {
      'eu-central-1': { required: 398, workloadConnections: 338 },
      'eu-west-1': { required: 366, workloadConnections: 306 },
    },
  });
});

test('autoscaling that exceeds PostgreSQL capacity fails closed', async () => {
  const input = await fixtures();
  input.autoscaling.services.worker.capacity['eu-central-1'].max = 11;

  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        input.budget,
        input.workloads,
        input.autoscaling,
        input.externalPlatform,
      ),
    /requires 416 of 400 connections/u,
  );
});

test('API-only rollout overlap is included in the budget', () => {
  const input = controlledServiceFixture(['api'], 1);

  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        input.budget,
        input.workloads,
        input.autoscaling,
        input.externalPlatform,
      ),
    /eu-central-1 database connection budget requires 2 of 1 connections/u,
  );
});

test('worker-only rollout overlap is included in the budget', () => {
  const input = controlledServiceFixture(['worker'], 1);

  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        input.budget,
        input.workloads,
        input.autoscaling,
        input.externalPlatform,
      ),
    /eu-central-1 database connection budget requires 2 of 1 connections/u,
  );
});

test('simultaneous API and worker rollout overlap is included in the budget', () => {
  const input = controlledServiceFixture(['api', 'worker'], 3);

  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        input.budget,
        input.workloads,
        input.autoscaling,
        input.externalPlatform,
      ),
    /eu-central-1 database connection budget requires 4 of 3 connections/u,
  );
});

test('ECS rollout task caps round down to whole tasks', () => {
  const input = controlledServiceFixture(['api'], 3);
  input.autoscaling.services.api.capacity['eu-central-1'].max = 3;
  input.externalPlatform.services.maximumPercent = 150;

  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        input.budget,
        input.workloads,
        input.autoscaling,
        input.externalPlatform,
      ),
    /eu-central-1 database connection budget requires 4 of 3 connections/u,
  );
});

test('reserved administration connections remain inside the capacity envelope', () => {
  const input = controlledServiceFixture(['api'], 1);
  input.budget.reservedAdministrationConnections = 1;
  input.externalPlatform.services.maximumPercent = 100;

  assert.throws(
    () =>
      calculateDatabaseConnectionBudget(
        input.budget,
        input.workloads,
        input.autoscaling,
        input.externalPlatform,
      ),
    /eu-central-1 database connection budget requires 2 of 1 connections/u,
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
        input.externalPlatform,
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
        drifted.externalPlatform,
      ),
    /workload inventory drifted/u,
  );
});
