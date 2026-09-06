function positiveInteger(value, label, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new Error(
      `${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer`,
    );
  return value;
}

function configuredPoolConnections(workload, rule, name) {
  const keys = rule.poolEnvironment ?? [];
  const fixed = rule.fixedPoolConnectionsPerTask ?? 0;
  if (keys.length > 0 && fixed !== 0)
    throw new Error(
      `${name} connection budget mixes fixed and configured pools`,
    );
  if (keys.length === 0)
    return positiveInteger(fixed, `${name} fixed pool connections`);
  return keys.reduce((total, key) => {
    const raw = workload.environment?.[key];
    if (typeof raw !== 'string' || !/^\d+$/u.test(raw))
      throw new Error(`${name} must declare numeric ${key} in its environment`);
    return total + positiveInteger(Number(raw), `${name} ${key}`);
  }, 0);
}

function maximumReplicas(rule, name, region, workloads, autoscaling) {
  if (Number.isSafeInteger(rule.replicas))
    return positiveInteger(rule.replicas, `${name} replicas`);
  if (rule.replicas === 'desired')
    return positiveInteger(
      workloads.workloads[name].desiredCount?.[region] ?? 0,
      `${name} ${region} desired replicas`,
      true,
    );
  if (rule.replicas === 'autoscaling')
    return positiveInteger(
      autoscaling.services[name]?.capacity?.[region]?.max,
      `${name} ${region} autoscaling maximum`,
    );
  throw new Error(`${name} has an unsupported replica budget source`);
}

function rolloutReplicas(workload, replicas, externalPlatform) {
  if (workload.kind !== 'service') return replicas;

  const maximumPercent = positiveInteger(
    externalPlatform.services?.maximumPercent,
    'external platform service maximum percent',
  );
  if (maximumPercent < 100)
    throw new Error(
      'external platform service maximum percent must allow the steady task count',
    );
  // ECS rounds the maximum task count down to a whole task.
  return Math.floor((replicas * maximumPercent) / 100);
}

export function calculateDatabaseConnectionBudget(
  budget,
  workloads,
  autoscaling,
  externalPlatform,
) {
  if (budget.schemaVersion !== 1)
    throw new Error('unsupported database connection budget schema version');
  const maximum = positiveInteger(
    budget.databaseMaximumConnections,
    'database maximum connections',
  );
  const reserved = positiveInteger(
    budget.reservedAdministrationConnections,
    'reserved administration connections',
    true,
  );
  const headroom = positiveInteger(
    budget.regionalFailoverHeadroomConnections,
    'regional failover headroom connections',
    true,
  );
  const pooler = budget.externalPooler;
  if (
    pooler === undefined ||
    !['none', 'session', 'transaction'].includes(pooler.mode)
  )
    throw new Error(
      'database connection budget must declare external pooler mode',
    );
  const poolerConnections = positiveInteger(
    pooler.maximumBackendConnections,
    'external pooler maximum backend connections',
    true,
  );
  if (pooler.mode === 'none' && poolerConnections !== 0)
    throw new Error(
      'external pooler connections must be zero when no pooler is used',
    );
  if (externalPlatform === undefined || externalPlatform.services === undefined)
    throw new Error(
      'database connection budget requires the external platform service contract',
    );

  const expected = Object.keys(workloads.workloads).sort();
  const actual = Object.keys(budget.workloads).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('database connection budget workload inventory drifted');

  const regions = ['eu-central-1', 'eu-west-1'];
  const totals = {};
  for (const region of regions) {
    let workloadConnections = 0;
    for (const [name, rule] of Object.entries(budget.workloads)) {
      const workload = workloads.workloads[name];
      const poolConnections = configuredPoolConnections(workload, rule, name);
      const poolCount = (rule.poolEnvironment?.length ?? 0) || 1;
      const monitorConnections =
        positiveInteger(
          rule.monitorConnectionsPerPool,
          `${name} monitor connections per pool`,
          true,
        ) * poolCount;
      const transientConnections = positiveInteger(
        rule.transientConnectionsPerTask,
        `${name} transient connections per task`,
        true,
      );
      const steadyReplicas = maximumReplicas(
        rule,
        name,
        region,
        workloads,
        autoscaling,
      );
      const replicas = rolloutReplicas(
        workload,
        steadyReplicas,
        externalPlatform,
      );
      workloadConnections +=
        replicas *
        (poolConnections + monitorConnections + transientConnections);
    }
    const required =
      workloadConnections + reserved + headroom + poolerConnections;
    if (required > maximum)
      throw new Error(
        `${region} database connection budget requires ${String(required)} of ${String(maximum)} connections`,
      );
    totals[region] = Object.freeze({ required, workloadConnections });
  }
  return Object.freeze({ maximum, regions: Object.freeze(totals) });
}
