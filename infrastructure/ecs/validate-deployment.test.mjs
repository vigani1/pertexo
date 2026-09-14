import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadDeploymentInputs,
  validateDeploymentContracts,
} from './validate-deployment.mjs';

const loaded = await loadDeploymentInputs();

function inputs() {
  const copy = JSON.parse(
    JSON.stringify({
      autoscaling: loaded.autoscaling,
      databaseConnectionBudget: loaded.databaseConnectionBudget,
      dockerfile: loaded.dockerfile,
      externalPlatform: loaded.externalPlatform,
      manifest: loaded.manifest,
      releaseJob: loaded.releaseJob,
    }),
  );
  return { ...copy, runtimeWorkspaces: loaded.runtimeWorkspaces };
}

test('accepts the repository deployment contracts through the pure seam', () => {
  assert.doesNotThrow(() => validateDeploymentContracts(inputs()));
});

test('rejects duplicate, omitted, and unknown autoscaling signals', () => {
  for (const mutate of [
    (value) => {
      value.autoscaling.services.api.signals[1] = {
        ...value.autoscaling.services.api.signals[0],
      };
    },
    (value) => {
      value.autoscaling.services.api.signals.pop();
    },
    (value) => {
      value.autoscaling.services.api.signals[1].name = 'unknown';
    },
  ]) {
    const value = inputs();
    mutate(value);
    assert.throws(
      () => validateDeploymentContracts(value),
      /must declare exactly the required scaling signals/u,
    );
  }
});

test('rejects nonnumeric, fractional, and negative desired counts', () => {
  for (const count of ['2', 2.5, -1]) {
    const value = inputs();
    value.manifest.workloads.api.desiredCount['eu-central-1'] = count;
    assert.throws(
      () => validateDeploymentContracts(value),
      /api has invalid eu-central-1 desired count/u,
    );
  }
});

test('requires literal environment, configuration, and secret names to be disjoint', () => {
  for (const mutate of [
    (workload) => workload.configuration.push(workload.configuration[0]),
    (workload) => workload.secrets.push(workload.secrets[0]),
    (workload) =>
      workload.configuration.push(Object.keys(workload.environment)[0]),
    (workload) => workload.configuration.push(workload.secrets[0]),
  ]) {
    const value = inputs();
    mutate(value.manifest.workloads.api);
    assert.throws(
      () => validateDeploymentContracts(value),
      /must be a distinct nonempty string list|names must be disjoint/u,
    );
  }
});

test('requires the exact workload inventory and command semantics', () => {
  const extra = inputs();
  extra.manifest.workloads.shadow = extra.manifest.workloads.api;
  assert.throws(
    () => validateDeploymentContracts(extra),
    /workload inventory must exactly match runtime roles/u,
  );

  const command = inputs();
  command.manifest.workloads.worker.command[2] += '; true';
  assert.throws(
    () => validateDeploymentContracts(command),
    /worker has the wrong command/u,
  );
});

test('rejects weakened platform role and migration policy independently', () => {
  const role = inputs();
  role.externalPlatform.evidence.requireDistinctTaskRoles = false;
  assert.throws(
    () => validateDeploymentContracts(role),
    /IAM evidence must fail closed/u,
  );

  const migration = inputs();
  migration.externalPlatform.migration.maximumConcurrentTasks = 2;
  assert.throws(
    () => validateDeploymentContracts(migration),
    /migration contract is unsafe/u,
  );
});
